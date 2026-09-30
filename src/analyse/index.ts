import type { LocaleSet, ScanResult, ScanSummary } from '../types.js';
import { findDuplicates, findVariants } from './duplicates.js';
import { findFuzzy, type FuzzyOptions } from './fuzzy.js';
import { findMissing } from './missing.js';
import { normalise } from './normalise.js';
import { findUnused, type UnusedOptions } from './unused.js';

export interface ScanOptions {
  source: string;
  fuzzy?: FuzzyOptions | false;
  allowIdentical?: Set<string>;
  /** Source code directory to check key usage against; skipped when absent. */
  srcDir?: string;
  unused?: UnusedOptions;
}

export async function scan(set: LocaleSet, opts: ScanOptions): Promise<ScanResult> {
  const source = set.locales.get(opts.source);
  if (!source) {
    throw new Error(`Source locale "${opts.source}" not found (have: ${[...set.locales.keys()].join(', ')})`);
  }

  const duplicates = findDuplicates(source);
  const variants = findVariants(source);
  const fuzzy = opts.fuzzy === false ? [] : findFuzzy(source, opts.fuzzy);

  const missing = [...set.locales]
    .filter(([locale]) => locale !== opts.source)
    .map(([locale, strings]) => findMissing(opts.source, source, locale, strings, { allowIdentical: opts.allowIdentical }));

  const unused = opts.srcDir ? await findUnused(source.keys(), opts.srcDir, opts.unused) : undefined;

  const dupKeys = new Set(duplicates.flatMap((g) => g.keys));
  const variantKeys = new Set(variants.flatMap((g) => g.members.flatMap((m) => m.keys)));
  const fuzzyKeys = new Set(fuzzy.flatMap((g) => g.members.flatMap((m) => m.keys)));
  const dupOrVariant = new Set([...dupKeys, ...variantKeys]);
  const redundant = new Set([...dupOrVariant, ...fuzzyKeys]);

  const nonBlank = [...source.values()].filter((v) => normalise(v));
  const summary: ScanSummary = {
    duplicateKeys: dupKeys.size,
    duplicateGroups: duplicates.length,
    variantKeys: variantKeys.size,
    variantGroups: variants.length,
    fuzzyKeys: fuzzyKeys.size,
    fuzzyGroups: fuzzy.length,
    duplicateOrVariantKeys: dupOrVariant.size,
    duplicateOrVariantPercent: percent(dupOrVariant.size, source.size),
    redundantKeys: redundant.size,
    redundantPercent: percent(redundant.size, source.size),
    collapsibleKeys: nonBlank.length - new Set(nonBlank.map(normalise)).size,
  };

  return {
    source: opts.source,
    sourceKeyCount: source.size,
    locales: [...set.locales.keys()],
    duplicates,
    variants,
    fuzzy,
    missing,
    unused,
    summary,
    warnings: set.warnings,
  };
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
