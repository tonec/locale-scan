import type { AlignResult } from './aligner.js';
import type { AlignRequest } from './pairs.js';
import { findOccurrences, lemma } from './terms.js';
import type { RenderingCluster, Term, TermLocaleStats, TermResult, Tier } from './types.js';

export interface ConsistencyOptions {
  /** Per-model minimum link similarity; weaker links count as unaligned. */
  minScore?: Record<string, number>;
  /** Model used per language, to look up minScore. */
  modelForLang: (lang: string) => string;
  /** A locale needs this many aligned occurrences before a term is judged there. */
  minOccurrences?: number;
  /** A rendering is a real alternative if it covers at least this share of occurrences... */
  minAltShare?: number;
  /** ...and at least this many. */
  minAltCount?: number;
  /** Term is "ambiguous" only if split in at least this many locales. */
  minFlagged?: number;
  /** Term is "ambiguous" when flagged in at least this share of evaluated locales. */
  ambiguousShare?: number;
  /** Term is "jargon" when rarer than this in general English (Zipf). */
  jargonZipf?: number;
  /** Inconsistent terms used as labels less often than this are "phrasing", not "ambiguous". */
  minLabelShare?: number;
  /** Terms left in English at least this often (mean across locales) are "keep-english". */
  keepEnglishShare?: number;
  maxExampleKeys?: number;
}

// Calibrated on sample pairs: mBERT's wrong links mostly score < 0.55, XLM-R's
// similarities run higher overall so its bar is higher.
export const DEFAULT_MIN_SCORE: Record<string, number> = {
  'bert-base-multilingual-cased': 0.55,
  'xlm-roberta-base': 0.75,
};

const UNSPACED = new Set(['ja', 'zh', 'th']);

interface Occurrence {
  cluster: string;
  text: string;
  keptEnglish: boolean;
  keys: string[];
}

export function measureConsistency(
  terms: Term[],
  requests: AlignRequest[],
  results: Map<number, AlignResult>,
  localeGroups: Map<string, string[]>,
  opts: ConsistencyOptions,
): TermResult[] {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const minOccurrences = opts.minOccurrences ?? 5;
  const minAltShare = opts.minAltShare ?? 0.2;
  const minAltCount = opts.minAltCount ?? 3;
  const minFlagged = opts.minFlagged ?? 3;
  const ambiguousShare = opts.ambiguousShare ?? 0.25;
  const jargonZipf = opts.jargonZipf ?? 3.5;
  const minLabelShare = opts.minLabelShare ?? 0.15;
  const keepEnglish = opts.keepEnglishShare ?? 0.5;
  const maxExampleKeys = opts.maxExampleKeys ?? 5;

  // Index terms by first lemma so each aligned pair only checks plausible terms.
  const byFirst = new Map<string, Term[]>();
  for (const t of terms) byFirst.set(t.lemmas[0]!, [...(byFirst.get(t.lemmas[0]!) ?? []), t]);

  // term id -> locale -> occurrences / unaligned count
  const occ = new Map<string, Map<string, { found: Occurrence[]; unaligned: number }>>();

  for (const req of requests) {
    const r = results.get(req.id);
    if (!r) continue;
    const lemmas = r.srcWords.map(lemma);
    const bar = minScore[opts.modelForLang(req.lang)] ?? 0;
    const unspaced = UNSPACED.has(req.lang);
    const candidates = new Set(lemmas.flatMap((l) => byFirst.get(l) ?? []));

    for (const term of candidates) {
      for (const start of findOccurrences(lemmas, term.lemmas)) {
        const perLocale = occ.get(term.id) ?? new Map();
        occ.set(term.id, perLocale);
        const bucket = perLocale.get(req.locale) ?? { found: [], unaligned: 0 };
        perLocale.set(req.locale, bucket);

        const idxs = term.lemmas.map((_, k) => start + k);
        const spans = idxs.filter((i) => r.spans[i] && (r.scores[i] ?? 0) >= bar).map((i) => r.spans[i]!);
        if (!spans.length) {
          bucket.unaligned++;
          continue;
        }
        let lo = Math.min(...spans.map((s) => s[0]));
        let hi = Math.max(...spans.map((s) => s[1]));
        if (unspaced) [lo, hi] = snapToScriptRuns(r.tgtUnits, lo, hi, req.lang);
        // Very wide spans are almost always a bad link stretched across the sentence.
        if (hi - lo + 1 > (unspaced ? 12 : term.lemmas.length * 2 + 1)) {
          bucket.unaligned++;
          continue;
        }
        const text = r.tgtUnits.slice(lo, hi + 1).join(r.joiner);
        const english = r.srcWords.slice(start, start + term.lemmas.length).join(' ');
        const keptEnglish = isKeptEnglish(text, english, term.id);
        const stemKey =
          req.lang === 'ja'
            ? japaneseKey(text)
            : r.tgtStems.slice(lo, hi + 1).join(unspaced ? '' : ' ').toLowerCase();
        bucket.found.push({ cluster: keptEnglish ? '=en' : stemKey, text, keptEnglish, keys: req.keys });
      }
    }
  }

  const results_: TermResult[] = [];
  for (const term of terms) {
    const perLocale: TermLocaleStats[] = [];
    for (const [locale, aliases] of localeGroups) {
      const bucket = occ.get(term.id)?.get(locale);
      if (!bucket) continue;
      const clusters = mergeInflections(mergeCompounds(cluster(bucket.found, maxExampleKeys)));
      const n = bucket.found.length;
      const translated = clusters.filter((c) => !c.keptEnglish);
      const nTranslated = translated.reduce((s, c) => s + c.count, 0);
      const dominant = translated[0]?.count ?? 0;
      // "Left in English" is a missing translation, not a competing meaning: judge only translated uses.
      const alternatives = translated.filter((c) => c.count >= Math.max(minAltCount, Math.ceil(minAltShare * nTranslated)));
      perLocale.push({
        locale,
        aliases,
        occurrences: n,
        unaligned: bucket.unaligned,
        clusters,
        dominantShare: nTranslated ? round(dominant / nTranslated) : 0,
        keptEnglishShare: n ? round((n - nTranslated) / n) : 0,
        multiple: nTranslated >= minOccurrences && alternatives.length >= 2,
      });
    }

    const evaluated = perLocale.filter((p) => p.occurrences * (1 - p.keptEnglishShare) >= minOccurrences);
    const flagged = evaluated.filter((p) => p.multiple).length;
    const consistency = evaluated.length ? round(evaluated.reduce((s, p) => s + p.dominantShare, 0) / evaluated.length) : 0;
    const zipfValue = term.zipf ?? null;
    const withData = perLocale.filter((p) => p.occurrences > 0);
    const keptEnglishShare = withData.length ? round(withData.reduce((s, p) => s + p.keptEnglishShare, 0) / withData.length) : 0;
    const rare = zipfValue !== null && zipfValue < jargonZipf;

    let tier: Tier;
    if (withData.length >= 3 && keptEnglishShare >= keepEnglish) tier = 'keep-english';
    else if (evaluated.length < 3) tier = rare && term.df > 0 ? 'jargon' : 'insufficient';
    else if (flagged >= minFlagged && flagged / evaluated.length >= ambiguousShare) {
      tier = term.labelShare >= minLabelShare ? 'ambiguous' : 'phrasing';
    } else tier = rare ? 'jargon' : 'stable';

    results_.push({
      term: term.id,
      surfaces: term.surfaces,
      df: term.df,
      seeded: term.seeded,
      zipf: zipfValue,
      labelShare: term.labelShare,
      keptEnglishShare,
      tier,
      localesEvaluated: evaluated.length,
      localesFlagged: flagged,
      consistency,
      perLocale,
    });
  }
  return results_;
}

function cluster(found: Occurrence[], maxExampleKeys: number): RenderingCluster[] {
  const map = new Map<string, { count: number; forms: Map<string, number>; keys: string[]; keptEnglish: boolean }>();
  for (const o of found) {
    const c = map.get(o.cluster) ?? { count: 0, forms: new Map<string, number>(), keys: [] as string[], keptEnglish: o.keptEnglish };
    c.count++;
    c.forms.set(o.text, (c.forms.get(o.text) ?? 0) + 1);
    for (const k of o.keys) if (c.keys.length < maxExampleKeys) c.keys.push(k);
    map.set(o.cluster, c);
  }
  return [...map].map(([key, c]) => ({
    key,
    count: c.count,
    forms: [...c.forms].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count),
    exampleKeys: c.keys,
    keptEnglish: c.keptEnglish,
  }));
}

/**
 * Fold compounds into their head cluster: "palettendepot" and "palett" are the
 * same concept in German. A single-token stem contained in another cluster's key
 * absorbs it. Returns clusters sorted by count.
 */
function mergeCompounds(clusters: RenderingCluster[]): RenderingCluster[] {
  const sorted = [...clusters].sort((a, b) => a.key.length - b.key.length);
  const kept: RenderingCluster[] = [];
  for (const c of sorted) {
    const host = c.keptEnglish
      ? undefined
      : kept.find((k) => !k.keptEnglish && !k.key.includes(' ') && k.key.length >= 4 && c.key.includes(k.key));
    if (host) {
      host.count += c.count;
      host.forms.push(...c.forms);
      host.forms.sort((a, b) => b.count - a.count);
      host.exampleKeys = [...host.exampleKeys, ...c.exampleKeys].slice(0, Math.max(host.exampleKeys.length, 5));
    } else kept.push({ ...c, forms: [...c.forms], exampleKeys: [...c.exampleKeys] });
  }
  return kept.sort((a, b) => b.count - a.count);
}

/**
 * The rendering keeps the English word: identical, part of it ("CHEP" for "myCHEP"),
 * or a compound built on it ("Supportanfragen" for "support").
 */
export function isKeptEnglish(text: string, english: string, termId: string): boolean {
  const t = foldLatin(text);
  const e = foldLatin(english);
  if (!t || !e) return false;
  if (t === e || lemmaPhrase(text) === termId) return true;
  if (!/^[a-z0-9]+$/.test(t)) return false;
  return (e.length >= 4 && t.includes(e)) || (t.length >= 3 && e.includes(t));
}

// Scripts whose runs mark word boundaries well enough to snap a partial match outwards.
const SNAP: Record<string, RegExp> = {
  ja: /^(?:\p{Script=Katakana}|ー|\p{Script=Han}|[A-Za-z0-9])$/u,
  zh: /^(?:[A-Za-z0-9])$/u,
  th: /^(?:[A-Za-z0-9])$/u,
};

function scriptOf(ch: string): string {
  if (/\p{Script=Katakana}|ー/u.test(ch)) return 'kana';
  if (/\p{Script=Han}/u.test(ch)) return 'han';
  if (/[A-Za-z0-9]/.test(ch)) return 'latin';
  return 'other';
}

/**
 * Subword units split words mid-way ("ポート" out of "サポート"). Extend the span
 * while the neighbouring unit continues the same katakana / Latin (/ kanji for
 * Japanese) run.
 */
export function snapToScriptRuns(units: string[], lo: number, hi: number, lang: string): [number, number] {
  const snappable = SNAP[lang];
  if (!snappable) return [lo, hi];
  const edge = (u: string, end: boolean) => [...u].at(end ? -1 : 0) ?? '';
  const joins = (a: string, b: string) => snappable.test(a) && snappable.test(b) && scriptOf(a) === scriptOf(b);
  while (lo > 0 && joins(edge(units[lo - 1]!, true), edge(units[lo]!, false))) lo--;
  while (hi + 1 < units.length && joins(edge(units[hi]!, true), edge(units[hi + 1]!, false))) hi++;
  return [lo, hi];
}

/** Japanese grouping key: drop hiragana (particles, okurigana) so 回復 and で回復する group together. */
export function japaneseKey(text: string): string {
  return text.replace(/\p{Script=Hiragana}/gu, '') || text;
}

/**
 * Merge inflected forms the stemmer missed (regiões / região, partnera / partner):
 * single-word keys sharing a prefix of at least max(4, 60% of the shorter key).
 */
function mergeInflections(clusters: RenderingCluster[]): RenderingCluster[] {
  const kept: RenderingCluster[] = [];
  for (const c of [...clusters].sort((a, b) => b.count - a.count)) {
    const host = c.keptEnglish ? undefined : kept.find((k) => !k.keptEnglish && sameInflection(k.key, c.key));
    if (host) {
      host.count += c.count;
      host.forms = [...host.forms, ...c.forms].sort((a, b) => b.count - a.count);
    } else kept.push({ ...c, forms: [...c.forms] });
  }
  return kept.sort((a, b) => b.count - a.count);
}

export function sameInflection(a: string, b: string): boolean {
  const wa = a.split(' ');
  const wb = b.split(' ');
  if (wa.length !== wb.length) return false;
  return wa.every((x, i) => {
    const y = wb[i]!;
    const lx = [...x].length;
    const ly = [...y].length;
    const shorter = Math.min(lx, ly);
    const prefix = commonPrefix(x, y);
    if (x === y || prefix >= Math.max(4, Math.ceil(0.6 * shorter))) return true;
    // Short words differing only in an ending: un / una / uno, der / den.
    return shorter <= 3 && prefix >= shorter - 1 && prefix >= 2 && Math.abs(lx - ly) <= 2;
  });
}

function commonPrefix(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  let i = 0;
  while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
  return i;
}

const foldLatin = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const lemmaPhrase = (s: string) => s.split(/\s+/).map(lemma).join(' ');
const round = (n: number) => Math.round(n * 1000) / 1000;
