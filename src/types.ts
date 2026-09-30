/** Flattened strings for one locale: dotted key -> value. */
export type LocaleStrings = Map<string, string>;

export interface ParseWarning {
  locale: string;
  file: string;
  key?: string;
  message: string;
}

export interface LocaleSet {
  /** Locale code -> flattened strings. */
  locales: Map<string, LocaleStrings>;
  /** Locale code -> files that contributed to it. */
  files: Map<string, string[]>;
  warnings: ParseWarning[];
}

export interface DuplicateGroup {
  value: string;
  keys: string[];
}

export type VariantKind = 'casing' | 'whitespace' | 'punctuation' | 'placeholder';

/** One distinct raw value and every key that uses it. */
export interface ValueKeys {
  value: string;
  keys: string[];
}

export interface VariantGroup {
  /** Normalised form shared by all members. */
  normalised: string;
  /** What distinguishes the raw values from one another. */
  kinds: VariantKind[];
  members: ValueKeys[];
}

export interface FuzzyGroup {
  /** Lowest pairwise similarity that linked this group (0..1). */
  minSimilarity: number;
  members: ValueKeys[];
}

export interface LocaleMissing {
  locale: string;
  /** Regional variant of the source language (e.g. en-gb for en): identical text is expected. */
  sameLanguageAsSource: boolean;
  absent: string[];
  empty: string[];
  likelyUntranslated: string[];
  extra: string[];
}

export interface UnusedResult {
  scannedFiles: number;
  unused: string[];
  /** Keys excluded from the unused check because they match a dynamic prefix. */
  skippedDynamic: number;
}

export interface ScanResult {
  source: string;
  sourceKeyCount: number;
  locales: string[];
  duplicates: DuplicateGroup[];
  variants: VariantGroup[];
  fuzzy: FuzzyGroup[];
  missing: LocaleMissing[];
  unused?: UnusedResult;
  summary: ScanSummary;
  warnings: ParseWarning[];
}

export interface ScanSummary {
  /** Keys whose value exactly equals another key's value. */
  duplicateKeys: number;
  duplicateGroups: number;
  variantKeys: number;
  variantGroups: number;
  fuzzyKeys: number;
  fuzzyGroups: number;
  /** Distinct keys in any exact-duplicate or normalised-variant group. */
  duplicateOrVariantKeys: number;
  /** duplicateOrVariantKeys / sourceKeyCount, 0..100. */
  duplicateOrVariantPercent: number;
  /** Distinct keys in any duplicate/variant/fuzzy group. */
  redundantKeys: number;
  /** redundantKeys / sourceKeyCount, 0..100. */
  redundantPercent: number;
  /** Keys minus distinct normalised values: how many keys exact/variant merging would remove. */
  collapsibleKeys: number;
}
