export interface Term {
  /** Lemma sequence, e.g. "docket number" (plurals folded, lowercase). */
  id: string;
  /** Word lemmas making up the term. */
  lemmas: string[];
  /** Raw surface forms seen in the source and how often. */
  surfaces: Record<string, number>;
  /** Number of distinct source strings containing the term. */
  df: number;
  /** Came from the seed list (kept even below --min-df). */
  seeded: boolean;
  /**
   * Share of its strings that are short labels (at most n+3 words): headings, buttons,
   * column names. Domain concepts are labels; phrasing words ("see", "cannot") aren't.
   */
  labelShare: number;
  /** Frequency in general English (wordfreq Zipf scale; <3 is rare, >5 very common). */
  zipf?: number;
}

/** One rendering cluster: target forms that share a stem (inflections, compounds). */
export interface RenderingCluster {
  /** Stem key the forms were grouped under ("=en" for "left in English"). */
  key: string;
  /** Distinct (source, target) string pairs rendered this way. */
  count: number;
  forms: { text: string; count: number }[];
  exampleKeys: string[];
  keptEnglish: boolean;
}

export interface TermLocaleStats {
  locale: string;
  /** Other locale codes with byte-identical files, reported under this one. */
  aliases: string[];
  /** Aligned occurrences (distinct source/target pairs). */
  occurrences: number;
  /** Occurrences the aligner couldn't place with enough confidence. */
  unaligned: number;
  clusters: RenderingCluster[];
  /** Share of translated occurrences using the most common rendering (0..1). */
  dominantShare: number;
  /** Share of occurrences left in English (0..1). */
  keptEnglishShare: number;
  /** Two or more renderings each used by a meaningful share of occurrences. */
  multiple: boolean;
}

/**
 * ambiguous    multiple renderings in many languages, used as a label: likely several meanings
 * jargon       rare in general English, translated consistently
 * keep-english mostly left in English (brand / product names, codes)
 * phrasing     multiple renderings, but only inside sentences: grammar/style, not meaning
 * stable       common English, translated consistently
 * insufficient not enough aligned uses to judge
 */
export type Tier = 'ambiguous' | 'jargon' | 'keep-english' | 'phrasing' | 'stable' | 'insufficient';

export interface ConceptDefinition {
  ambiguous: boolean;
  senses: { label: string; definition: string; exampleKeys: string[] }[];
  translatorNote: string;
  confidence: 'low' | 'medium' | 'high';
  model: string;
}

export interface TermResult {
  term: string;
  surfaces: Record<string, number>;
  df: number;
  seeded: boolean;
  zipf: number | null;
  labelShare: number;
  /** Mean share of uses left in English across locales with data (0..1). */
  keptEnglishShare: number;
  tier: Tier;
  localesEvaluated: number;
  localesFlagged: number;
  /** Mean dominant-rendering share across evaluated locales (0..1). */
  consistency: number;
  perLocale: TermLocaleStats[];
  definition?: ConceptDefinition;
}

export interface VocabEstimate {
  candidates: number;
  byTier: Record<Tier, number>;
  /** Glossary-worthy terms (ambiguous + jargon) at increasing frequency cut-offs. */
  glossaryByMinDf: { minDf: number; terms: number }[];
}

export interface VocabResult {
  source: string;
  /** Representative locale -> byte-identical aliases. */
  localeGroups: Record<string, string[]>;
  skippedLocales: { locale: string; reason: string }[];
  alignment: { pairs: number; models: Record<string, string> };
  estimate: VocabEstimate;
  terms: TermResult[];
}
