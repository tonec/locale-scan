import type { TermResult, Tier, VocabEstimate } from './types.js';

export const GLOSSARY_TIERS: Tier[] = ['ambiguous', 'jargon'];

/** How big the vocabulary-building step would be: glossary-worthy terms at several frequency cut-offs. */
export function estimate(terms: TermResult[], cutoffs = [5, 10, 25, 50]): VocabEstimate {
  const byTier: Record<Tier, number> = { ambiguous: 0, jargon: 0, 'keep-english': 0, phrasing: 0, stable: 0, insufficient: 0 };
  for (const t of terms) byTier[t.tier]++;
  const glossary = terms.filter((t) => GLOSSARY_TIERS.includes(t.tier));
  return {
    candidates: terms.length,
    byTier,
    glossaryByMinDf: cutoffs.map((minDf) => ({ minDf, terms: glossary.filter((t) => t.df >= minDf).length })),
  };
}

/** Glossary candidates, most in need of a definition first. */
export function rankForGlossary(terms: TermResult[]): TermResult[] {
  // Ambiguous first, weighted by how widely split and how often used; then jargon by frequency.
  const split = (t: TermResult) => t.localesFlagged / Math.max(1, t.localesEvaluated);
  const score = (t: TermResult) =>
    t.tier === 'ambiguous' ? 10 + split(t) * Math.log10(10 + t.df) * Math.min(1, t.labelShare * 2) : t.tier === 'jargon' ? 1 : 0;
  return terms
    .filter((t) => GLOSSARY_TIERS.includes(t.tier))
    .sort((a, b) => score(b) - score(a) || b.df - a.df || a.term.localeCompare(b.term));
}
