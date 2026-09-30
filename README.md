# locale-scan

Two commands:

- `locale-scan [scan] <localeDir>`: duplicate, variant, missing and unused strings (below).
- `locale-scan vocab <localeDir>`: mines domain terms and measures how consistently each one was translated (see [Vocabulary mining](#vocabulary-mining)).

`scan` reports:

- **Exact duplicates:** the same source string under different keys.
- **Normalised variants:** strings that differ only in casing, whitespace, punctuation or placeholder names (`Submit order` / `SUBMIT ORDER` / `Submit order.`).
- **Fuzzy near-duplicates:** small wording drift or reordered words (`Reverse transfer in` / `Reversed transfer in`, `Date submitted` / `Submitted date`).
- **Missing translations per locale:** absent keys, empty values, keys only in the target (extra), and *likely untranslated* values (identical to the source text, excluding codes, numbers and placeholder-only strings). Regional variants of the source language (e.g. `en-gb` for `en`) are not checked for untranslated text, because identical text is expected there.
- **Unused keys:** optional, when given a source-code directory to search.

## Usage

```sh
npm install
npm run build
node dist/bin.js <localeDir> [options]      # or: npm run dev -- <localeDir> [options]
```

Supported layouts are `<localeDir>/<locale>.json` and `<localeDir>/<locale>/<namespace>.json` (keys get a `<namespace>.` prefix). Files can be flat or nested; nested keys are flattened with `.`.

| Option | Default | |
| --- | --- | --- |
| `--source <locale>` | `en` | Source locale |
| `--format text\|json\|both` | `text` | `both` prints text and writes JSON to `--out` |
| `--out <file>` | | Write the JSON report to a file |
| `--src <dir>` | | Check key usage in this code directory |
| `--dynamic-prefix <p>` | | Key prefix built at runtime (repeatable) |
| `--fuzzy-threshold <0..1>` | `0.85` | Similarity needed to link two strings |
| `--fuzzy-max-len <n>` | `200` | Skip longer strings in fuzzy matching |
| `--no-fuzzy` | | Disable fuzzy matching |
| `--allow-identical <file>` | | Newline-separated source strings allowed to stay untranslated (brand names, country names) |
| `--separator <char>` | `.` | Separator for flattening nested keys |
| `--top <n>` | `10` | Groups listed per section in the text report |
| `--fail-on <list>` | | Exit 1 if any of `missing,untranslated,duplicates,variants,fuzzy,unused` are found |

Exit codes: `0` ok, `1` a `--fail-on` check triggered, `2` usage or input error.

## How it works

`src/parse` loads the files into `Map<key, value>` per locale. `src/analyse` runs the independent analysers and builds a `ScanResult` (`src/types.ts`). `src/report` renders that result as text or JSON (the JSON includes `reportVersion`).

- Normalisation (`analyse/normalise.ts`) runs a series of steps in order: whitespace, then placeholders/markup, then casing, then punctuation. A variant group is labelled with the steps at which its values merged.
- Fuzzy matching (`analyse/fuzzy.ts`) works on distinct normalised strings, so exact duplicates and variants are never re-reported. It avoids comparing every pair by only comparing strings that share a reasonably rare word (or, for 1–2 word strings, a character trigram). Similarity is `max(Levenshtein similarity, similarity of sorted words)`. Strings that differ only in numbers are ignored, and linked strings are merged into groups with union-find.
- Unused-key detection is a heuristic. A key counts as used if it appears as a string literal. Template literals such as `` `error.${code}` `` and fragments such as `'level.' + x` mark their prefix as dynamic, and matching keys are counted separately rather than reported as unused.

## Vocabulary mining

```sh
npm run setup:aligner            # one-off: Python venv with torch/transformers (~2.5 GB) in aligner/.venv
node dist/bin.js vocab <localeDir> [--locales de,ja] [--format both --out reports/vocab.json]
node dist/bin.js vocab <localeDir> --define                       # also draft concept definitions with Claude (ANTHROPIC_API_KEY)
node dist/bin.js vocab <localeDir> --define --provider claude-code  # ...or through the Claude Code CLI on your Claude plan
node dist/bin.js vocab <localeDir> --define --provider gemini     # ...or with Gemini (GEMINI_API_KEY)
```

How it works:

1. **Candidate terms** (`src/vocab/terms.ts`): words and 2–3 word phrases found in at least `--min-df` distinct source strings, with plurals folded and stopwords dropped. A phrase must appear at least once as a short label, and a term that only occurs inside one longer phrase is dropped in favour of that phrase. Terms in a `--seed` file are always included.
2. **Locale plan** (`src/vocab/pairs.ts`): byte-identical locales are folded into one (`de` = `de-de`), same-language variants of the source are skipped, and untranslated or blank targets are ignored.
3. **Word alignment** (`aligner/align.py`, a Python sidecar using the GPU on Apple Silicon): SimAlign-style mutual-argmax and itermax links over layer 8 of `bert-base-multilingual-cased`. XLM-R is used for Thai, because mBERT tokenises Thai badly. Each link is grown over neighbouring subword units, so that, for example, "pallet" covers all of パレット. Results are cached in `~/.cache/locale-scan/align.sqlite`: the first full run takes about 90 seconds on an M2 Max, reruns take a few seconds.
4. **Consistency** (`src/vocab/consistency.ts`): for each term and locale, renderings are grouped using stems, compounds, shared prefixes and (for Japanese) the text with hiragana removed. "Left in English" is counted separately. Links with low confidence or unusually wide spans count as unaligned.
5. **Tiers**:
   - `ambiguous`: two or more renderings each covering at least 20% of uses, in at least 25% (and at least 3) of the languages, and the term is used as a label.
   - `phrasing`: split in the same way, but only inside sentences, so the variation is grammar rather than meaning.
   - `jargon`: rare in general English (wordfreq Zipf < 3.5).
   - `keep-english`: left in English in most languages.
   - `stable` and `insufficient`: consistently translated, and too little aligned data to judge.
6. **Estimate:** glossary-worthy terms (ambiguous + jargon) counted at several frequency cut-offs.

`--define` sends the top glossary candidates, with their renderings, example keys and English strings, to an LLM, and gets back senses, definitions and a note for translators. Both providers get the same prompt and the same output schema (`src/vocab/define.ts`), and results are cached per provider and model next to the alignment cache.

| `--provider` | SDK | Default `--define-model` | Credentials |
| --- | --- | --- | --- |
| `claude` (default) | `@anthropic-ai/sdk`: structured output, server-side fallback on refusals | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| `claude-code` | Local Claude Code CLI (`claude -p --json-schema`), no tools, no saved sessions | `opus` (alias) | Your Claude plan (`claude` logged in); `LOCALE_SCAN_CLAUDE_BIN` overrides the binary |
| `gemini` | `@google/genai`: JSON mode with `responseJsonSchema`, validated with zod | `gemini-3.1-pro-preview` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |

## Development

```sh
npm test              # vitest; fixtures in test/fixtures are synthetic, the aligner is stubbed
npm run test:aligner  # Python unit tests for the alignment maths
npm run typecheck
```

Generated reports go in `reports/`, which is git-ignored.
