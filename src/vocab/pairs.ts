import { stripPlaceholders } from '../analyse/normalise.js';
import type { LocaleSet, LocaleStrings } from '../types.js';
import { lemma, words } from './terms.js';
import type { Term } from './types.js';

export interface AlignRequest {
  id: number;
  locale: string;
  /** Language passed to the aligner (stemmer / segmentation choice): pt-br -> pt. */
  lang: string;
  /** Placeholder-free text actually aligned (both sides cleaned the same way). */
  src: string;
  tgt: string;
  /** Every key whose (source, target) pair reduces to this request. */
  keys: string[];
}

export interface LocalePlan {
  /** Representative locale -> byte-identical aliases (de -> [de-de]). */
  groups: Map<string, string[]>;
  skipped: { locale: string; reason: string }[];
}

export const language = (locale: string) => locale.split('-')[0]!;

/**
 * Collapse locales whose strings are identical (keeping the shortest code) and
 * drop same-language variants of the source (en-gb for en: that's task 3).
 */
export function planLocales(set: LocaleSet, source: string, only?: string[]): LocalePlan {
  const groups = new Map<string, string[]>();
  const skipped: LocalePlan['skipped'] = [];
  const fingerprints = new Map<string, string>();

  const codes = [...set.locales.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const code of codes) {
    if (code === source) continue;
    if (only && !only.includes(code) && !only.includes(language(code))) continue;
    if (language(code) === language(source)) {
      skipped.push({ locale: code, reason: 'same language as source' });
      continue;
    }
    const fp = fingerprint(set.locales.get(code)!);
    const rep = fingerprints.get(fp);
    if (rep) groups.get(rep)!.push(code);
    else {
      fingerprints.set(fp, code);
      groups.set(code, []);
    }
  }
  return { groups, skipped };
}

function fingerprint(strings: LocaleStrings): string {
  return JSON.stringify([...strings].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/**
 * One request per distinct (source text, target text) pair in each locale whose
 * source contains at least one candidate term. Untranslated (identical) and
 * blank targets are skipped: there is no rendering to learn from them.
 */
export function buildRequests(source: LocaleStrings, set: LocaleSet, locales: string[], terms: Term[]): AlignRequest[] {
  const firstLemmas = new Set(terms.map((t) => t.lemmas[0]!));
  const relevant = new Map<string, string>(); // key -> placeholder-free source text
  for (const [key, value] of source) {
    if (words(value).some((w) => firstLemmas.has(lemma(w)))) relevant.set(key, clean(value));
  }

  const requests: AlignRequest[] = [];
  for (const locale of locales) {
    const target = set.locales.get(locale)!;
    const byPair = new Map<string, AlignRequest>();
    for (const [key, src] of relevant) {
      const raw = target.get(key);
      if (!raw?.trim() || raw === source.get(key)) continue;
      const tgt = clean(raw);
      if (!tgt) continue;
      const pairKey = `${src}\u0000${tgt}`;
      const existing = byPair.get(pairKey);
      if (existing) existing.keys.push(key);
      else {
        const req = { id: requests.length, locale, lang: language(locale), src, tgt, keys: [key] };
        byPair.set(pairKey, req);
        requests.push(req);
      }
    }
  }
  return requests;
}

/** Placeholders/markup removed and whitespace collapsed; punctuation is kept as context for the aligner. */
function clean(value: string): string {
  return stripPlaceholders(value).replace(/\s+/g, ' ').trim();
}
