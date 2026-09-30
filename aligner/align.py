"""Word aligner sidecar for `locale-scan vocab`.

SimAlign-style alignment (Jalili Sabet et al., 2020): embed both sides with a
multilingual encoder, take cosine similarity between word vectors from a middle
layer, and keep links that are mutual best matches ("argmax"), optionally
extended with a second "itermax" pass for words left unaligned.

Commands (JSON Lines on stdin/stdout, progress on stderr):

  align  in:  {"id", "src", "tgt", "lang"}          (src is English)
         out: {"id", "srcWords", "tgtUnits", "tgtStems", "joiner", "links": [[i, j], ...],
               "spans": [[start, end] | null per source word],   (inclusive target unit range)
               "scores": [best link similarity | null per source word]}
  zipf   in:  {"term"}                              out: {"term", "zipf"}

Target "units" are words for space-delimited languages and model subword pieces
for ja/zh/th, where `joiner` is "" so adjacent units can be glued back together.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from typing import Iterable

import numpy as np
import regex

UNSPACED = {"ja", "zh", "th"}
WORD_RE = regex.compile(r"[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*")

# locale language -> Snowball algorithm. Slovak borrows Czech (closely related);
# Bulgarian has none and falls back to prefix truncation.
SNOWBALL = {
    "cs": "czech", "sk": "czech", "de": "german", "el": "greek", "es": "spanish",
    "et": "estonian", "fi": "finnish", "fr": "french", "hu": "hungarian", "it": "italian",
    "nl": "dutch", "pl": "polish", "pt": "portuguese", "ro": "romanian", "ru": "russian",
    "sr": "serbian", "tr": "turkish",
}
PREFIX_STEM = 5
# Bump when alignment output changes so stale cache entries are ignored.
ALGO_VERSION = "3"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class Stemmer:
    def __init__(self) -> None:
        import snowballstemmer

        self._mod = snowballstemmer
        self._cache: dict[str, object] = {}

    def stem(self, lang: str, word: str) -> str:
        w = word.lower()
        if lang in UNSPACED:
            return w
        algo = SNOWBALL.get(lang)
        if not algo:
            return w[:PREFIX_STEM]
        if algo not in self._cache:
            self._cache[algo] = self._mod.stemmer(algo)
        return self._cache[algo].stemWord(w)  # type: ignore[attr-defined]


class Encoder:
    """Word-level vectors from one hidden layer; a word's vector is the mean of its subword vectors."""

    def __init__(self, model_name: str, layer: int, device: str, batch_size: int) -> None:
        import torch
        from transformers import AutoModel, AutoTokenizer

        self.torch = torch
        self.tok = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name, output_hidden_states=True).to(device).eval()
        self.layer = layer
        self.device = device
        self.batch_size = batch_size

    def units(self, text: str, unspaced: bool) -> list[tuple[int, int]]:
        """Character spans of the alignment units in `text`."""
        if not unspaced:
            return [m.span() for m in WORD_RE.finditer(text)]
        enc = self.tok(text, add_special_tokens=False, return_offsets_mapping=True)
        spans = []
        for start, end in enc["offset_mapping"]:
            # Drop whitespace/punctuation-only pieces; trim a leading space some tokenizers include.
            piece = text[start:end]
            stripped = piece.lstrip()
            start += len(piece) - len(stripped)
            if start < end and WORD_RE.search(text[start:end]):
                if spans and start < spans[-1][1]:
                    # Overlapping pieces (e.g. XLM-R's lone "▁" mapped onto the next char): merge.
                    spans[-1] = (spans[-1][0], max(end, spans[-1][1]))
                else:
                    spans.append((start, end))
        return spans

    def encode(self, texts: list[str], spans: list[list[tuple[int, int]]]) -> list[np.ndarray]:
        out: list[np.ndarray] = [np.zeros((0, 0), dtype=np.float32)] * len(texts)
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))  # length-sorted batches pad less
        for b in range(0, len(order), self.batch_size):
            idx = order[b : b + self.batch_size]
            enc = self.tok(
                [texts[i] for i in idx],
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=256,
                return_offsets_mapping=True,
            )
            offsets = enc.pop("offset_mapping").numpy()
            with self.torch.no_grad():
                hidden = self.model(**{k: v.to(self.device) for k, v in enc.items()}).hidden_states[self.layer]
            hidden = self.torch.nn.functional.normalize(hidden.float(), dim=-1).cpu().numpy()
            for row, i in enumerate(idx):
                vecs = np.zeros((len(spans[i]), hidden.shape[-1]), dtype=np.float32)
                for w, (ws, we) in enumerate(spans[i]):
                    # Subword tokens overlapping this word's span (special/pad tokens have (0, 0)).
                    tok_mask = (offsets[row, :, 1] > ws) & (offsets[row, :, 0] < we) & (offsets[row, :, 1] > offsets[row, :, 0])
                    if tok_mask.any():
                        v = hidden[row, tok_mask].mean(axis=0)
                        vecs[w] = v / (np.linalg.norm(v) or 1.0)
                out[i] = vecs
        return out


def mutual_argmax(sim: np.ndarray) -> np.ndarray:
    m, n = sim.shape
    fwd = np.zeros_like(sim, dtype=bool)
    fwd[np.arange(m), sim.argmax(axis=1)] = True
    bwd = np.zeros_like(sim, dtype=bool)
    bwd[sim.argmax(axis=0), np.arange(n)] = True
    return fwd & bwd


def itermax(sim: np.ndarray, rounds: int = 2, alpha: float = 0.9) -> np.ndarray:
    """Mutual argmax, then re-run it for words still unaligned with already-aligned rows/cols down-weighted."""
    links = mutual_argmax(sim)
    if min(sim.shape) <= 2:
        return links
    for _ in range(rounds - 1):
        free_rows = ~links.any(axis=1)
        free_cols = ~links.any(axis=0)
        if not free_rows.any() or not free_cols.any():
            break
        weight = np.clip(alpha * free_rows[:, None] + alpha * free_cols[None, :], 0.0, 1.0)
        # Only a link touching at least one still-free word may be added.
        allowed = free_rows[:, None] | free_cols[None, :]
        added = mutual_argmax(sim * weight) & allowed & ~links
        if not added.any():
            break
        links |= added
    return links


def grow_spans(sim: np.ndarray, links: np.ndarray, max_grow: int) -> list[list[int] | None]:
    """
    Per source word, the contiguous target range covered by its links, grown over
    neighbouring units whose best source match is that same word. One English word
    often maps to several target units ("pallet" -> パ レ ッ ト, "docket number" ->
    one German compound), which 1:1 mutual-argmax links alone can't express.
    """
    best_src = sim.argmax(axis=0)
    owned = links.any(axis=0)
    spans: list[list[int] | None] = []
    for i in range(sim.shape[0]):
        js = np.nonzero(links[i])[0]
        if not len(js):
            spans.append(None)
            continue
        lo, hi = int(js.min()), int(js.max())
        for _ in range(max_grow):
            if lo > 0 and best_src[lo - 1] == i and not owned[lo - 1]:
                lo -= 1
            else:
                break
        for _ in range(max_grow):
            if hi + 1 < sim.shape[1] and best_src[hi + 1] == i and not owned[hi + 1]:
                hi += 1
            else:
                break
        spans.append([lo, hi])
    return spans


def cache_key(model: str, layer: int, method: str, lang: str, src: str, tgt: str) -> str:
    return hashlib.sha1("\x1f".join([ALGO_VERSION, model, str(layer), method, lang, src, tgt]).encode()).hexdigest()


def open_cache(path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS align (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    return db


def read_jsonl(stream: Iterable[str]) -> list[dict]:
    return [json.loads(line) for line in stream if line.strip()]


def cmd_align(args: argparse.Namespace) -> None:
    rows = read_jsonl(sys.stdin)
    db = open_cache(args.cache)
    method = args.method
    overrides = dict(kv.split("=", 1) for kv in args.model_for or [])
    model_for = lambda lang: overrides.get(lang, args.model)  # noqa: E731
    keys = [cache_key(model_for(r["lang"]), args.layer, method, r["lang"], r["src"], r["tgt"]) for r in rows]

    cached: dict[str, str] = {}
    for b in range(0, len(keys), 500):
        chunk = keys[b : b + 500]
        q = f"SELECT k, v FROM align WHERE k IN ({','.join('?' * len(chunk))})"
        cached.update(db.execute(q, chunk).fetchall())
    todo = [i for i, k in enumerate(keys) if k not in cached]
    log(f"align: {len(rows)} pairs, {len(rows) - len(todo)} cached, {len(todo)} to compute")

    by_model: dict[str, list[int]] = {}
    for i in todo:
        by_model.setdefault(model_for(rows[i]["lang"]), []).append(i)

    device = args.device or ("mps" if _mps() else "cpu")
    stemmer = Stemmer()
    t0 = time.time()
    for model, model_idxs in sorted(by_model.items()):
        enc = Encoder(model, args.layer, device, args.batch_size)
        log(f"align: loaded {model} (layer {args.layer}) on {device}, {time.time() - t0:.1f}s elapsed")

        # English sources are shared by every language: embed each distinct one once per model.
        srcs = sorted({rows[i]["src"] for i in model_idxs})
        src_spans = [enc.units(s, False) for s in srcs]
        src_vecs = dict(zip(srcs, enc.encode(srcs, src_spans)))
        src_span_map = dict(zip(srcs, src_spans))
        log(f"align: embedded {len(srcs)} source strings, {time.time() - t0:.1f}s elapsed")

        by_lang: dict[str, list[int]] = {}
        for i in model_idxs:
            by_lang.setdefault(rows[i]["lang"], []).append(i)

        for lang, idxs in sorted(by_lang.items()):
            unspaced = lang in UNSPACED
            tgts = sorted({rows[i]["tgt"] for i in idxs})
            tgt_spans = [enc.units(t, unspaced) for t in tgts]
            tgt_vecs = dict(zip(tgts, enc.encode(tgts, tgt_spans)))
            tgt_span_map = dict(zip(tgts, tgt_spans))
            batch = []
            for i in idxs:
                r = rows[i]
                result = align_pair(r, src_vecs[r["src"]], tgt_vecs[r["tgt"]], src_span_map[r["src"]], tgt_span_map[r["tgt"]], method, stemmer)
                v = json.dumps(result, ensure_ascii=False)
                cached[keys[i]] = v
                batch.append((keys[i], v))
            db.executemany("INSERT OR REPLACE INTO align (k, v) VALUES (?, ?)", batch)
            db.commit()
            log(f"align: {lang}: {len(idxs)} pairs ({len(tgts)} distinct targets), {time.time() - t0:.1f}s elapsed")

    out = sys.stdout
    for r, k in zip(rows, keys):
        out.write('{"id":' + json.dumps(r["id"]) + "," + cached[k][1:] + "\n")
    out.flush()


def align_pair(r: dict, sv: np.ndarray, tv: np.ndarray, s_spans: list, t_spans: list, method: str, stemmer: Stemmer) -> dict:
    lang = r["lang"]
    unspaced = lang in UNSPACED
    if len(sv) and len(tv):
        sim = sv @ tv.T
        m = itermax(sim) if method == "itermax" else mutual_argmax(sim)
        links = [[int(a), int(b)] for a, b in zip(*np.nonzero(m))]
        spans = grow_spans(sim, m, max_grow=8 if unspaced else 2)
        # Confidence per source word: best cosine similarity among its links.
        scores = [round(float(sim[i][m[i]].max()), 3) if m[i].any() else None for i in range(len(s_spans))]
    else:
        links, spans, scores = [], [None] * len(s_spans), [None] * len(s_spans)
    t_units = [r["tgt"][s:e] for s, e in t_spans]
    return {
        "srcWords": [r["src"][s:e] for s, e in s_spans],
        "tgtUnits": t_units,
        "tgtStems": [stemmer.stem(lang, u) for u in t_units],
        "joiner": "" if unspaced else " ",
        "links": links,
        "spans": spans,
        "scores": scores,
    }


def cmd_zipf(_: argparse.Namespace) -> None:
    from wordfreq import zipf_frequency

    for r in read_jsonl(sys.stdin):
        sys.stdout.write(json.dumps({"term": r["term"], "zipf": zipf_frequency(r["term"], "en")}) + "\n")
    sys.stdout.flush()


def _mps() -> bool:
    try:
        import torch

        return torch.backends.mps.is_available()
    except Exception:
        return False


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("align")
    a.add_argument("--model", default="bert-base-multilingual-cased")
    a.add_argument("--model-for", action="append", metavar="LANG=MODEL", help="per-language model override (repeatable)")
    a.add_argument("--layer", type=int, default=8)
    a.add_argument("--method", choices=["argmax", "itermax"], default="itermax")
    a.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), ".cache", "align.sqlite"))
    a.add_argument("--device", default=None)
    a.add_argument("--batch-size", type=int, default=64)
    a.set_defaults(fn=cmd_align)
    z = sub.add_parser("zipf")
    z.set_defaults(fn=cmd_zipf)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
