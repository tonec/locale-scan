import { stripPlaceholders } from '../analyse/normalise.js';
import type { LocaleStrings } from '../types.js';
import type { Term } from './types.js';

// Same word definition as the Python aligner (aligner/align.py WORD_RE).
const WORD_RE = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/gu;

// Function words plus UI boilerplate that never needs a glossary entry.
const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers him his how i if
  in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she
  should so some such than that the their theirs them then there these they this those through to too under until up very
  was we were what when where which while who whom why will with would you your yours yourself also may must shall us via
  per etc eg ie please click here yes ok cancel close back next previous`.split(/\s+/),
);

/** Words that may sit inside a phrase ("proof of delivery") but not at its edges. */
const INNER_OK = new Set(['of', 'and', 'to', 'in', 'for', 'on', 'by', 'at', '&']);

export function words(text: string): string[] {
  return stripPlaceholders(text).match(WORD_RE) ?? [];
}

/** Lowercase and fold regular English plurals: pallets -> pallet, deliveries -> delivery. */
export function lemma(word: string): string {
  const w = word.toLowerCase().replace(/’/g, "'");
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|z|us)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !/(?:ss|us|is|'s)$/.test(w)) return w.slice(0, -1);
  return w;
}

export interface TermOptions {
  minDf?: number;
  maxN?: number;
  /** Phrase n-grams must account for at least this share of their rarest word's uses. */
  minCohesion?: number;
  /** Drop a term when one longer phrase containing it covers at least this share of its uses. */
  maxSubsumption?: number;
  seeds?: string[];
}

/**
 * Candidate domain terms from the source locale: frequent words and 2-3 word
 * phrases. Frequency is counted over distinct strings, so one message copied
 * under 500 keys counts once.
 */
export function extractTerms(source: LocaleStrings, opts: TermOptions = {}): Term[] {
  const minDf = opts.minDf ?? 5;
  const maxN = opts.maxN ?? 3;
  const minCohesion = opts.minCohesion ?? 0.3;
  const maxSubsumption = opts.maxSubsumption ?? 0.9;

  const df = new Map<string, number>();
  const labels = new Map<string, number>(); // strings of at most n+3 words containing the term
  const surfaces = new Map<string, Map<string, number>>();

  for (const value of new Set(source.values())) {
    const ws = words(value);
    const lemmas = ws.map(lemma);
    const seen = new Set<string>();
    for (let n = 1; n <= maxN; n++) {
      for (let i = 0; i + n <= ws.length; i++) {
        const gram = lemmas.slice(i, i + n);
        if (!isCandidate(gram)) continue;
        const id = gram.join(' ');
        const surface = ws.slice(i, i + n).join(' ');
        const forms = surfaces.get(id) ?? new Map<string, number>();
        forms.set(surface, (forms.get(surface) ?? 0) + 1);
        surfaces.set(id, forms);
        if (!seen.has(id)) {
          seen.add(id);
          df.set(id, (df.get(id) ?? 0) + 1);
          if (ws.length <= n + 3) labels.set(id, (labels.get(id) ?? 0) + 1);
        }
      }
    }
  }

  const seedIds = new Set((opts.seeds ?? []).map((s) => words(s).map(lemma).join(' ')).filter(Boolean));
  const terms: Term[] = [];
  for (const [id, count] of df) {
    const lemmas = id.split(' ');
    const seeded = seedIds.has(id);
    const labelCount = labels.get(id) ?? 0;
    if (!seeded) {
      if (count < minDf) continue;
      if (lemmas.length > 1) {
        // A phrase that is never a label on its own ("make sure", "least one") isn't a concept.
        if (labelCount === 0) continue;
        const rarest = Math.min(...lemmas.filter((l) => !INNER_OK.has(l)).map((l) => df.get(l) ?? count));
        if (count / rarest < minCohesion) continue;
      }
    }
    terms.push({ id, lemmas, surfaces: Object.fromEntries(surfaces.get(id)!), df: count, seeded, labelShare: round(labelCount / count) });
  }

  // "transfer requiring" only ever appears inside "transfer requiring action": keep the longer one.
  const ids = new Set(terms.map((t) => t.id));
  const subsumed = new Set<string>();
  for (const longer of terms) {
    if (longer.lemmas.length < 2) continue;
    for (let n = 1; n < longer.lemmas.length; n++) {
      for (let i = 0; i + n <= longer.lemmas.length; i++) {
        const inner = longer.lemmas.slice(i, i + n).join(' ');
        if (ids.has(inner) && longer.df >= maxSubsumption * df.get(inner)!) subsumed.add(inner);
      }
    }
  }
  const kept = terms.filter((t) => t.seeded || !subsumed.has(t.id));
  terms.length = 0;
  terms.push(...kept);
  // Seeds that never occur still get reported (df 0), so a typo in the seed file is visible.
  for (const id of seedIds) {
    if (!df.has(id)) terms.push({ id, lemmas: id.split(' '), surfaces: {}, df: 0, seeded: true, labelShare: 0 });
  }
  return terms.sort((a, b) => b.df - a.df || a.id.localeCompare(b.id));
}

function isCandidate(gram: string[]): boolean {
  const first = gram[0]!;
  const last = gram[gram.length - 1]!;
  if (gram.length === 1) return first.length >= 3 && !STOPWORDS.has(first) && !/^\d/.test(first);
  if (STOPWORDS.has(first) || STOPWORDS.has(last)) return false;
  if (gram.some((g) => /^\d/.test(g))) return false;
  return gram.slice(1, -1).every((g) => INNER_OK.has(g) || !STOPWORDS.has(g));
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Start indices where `term` occurs in a lemmatised word sequence. */
export function findOccurrences(lemmas: string[], term: string[]): number[] {
  const out: number[] = [];
  outer: for (let i = 0; i + term.length <= lemmas.length; i++) {
    for (let k = 0; k < term.length; k++) if (lemmas[i + k] !== term[k]) continue outer;
    out.push(i);
  }
  return out;
}
