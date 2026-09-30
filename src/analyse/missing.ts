import type { LocaleMissing, LocaleStrings } from '../types.js';
import { stripPlaceholders } from './normalise.js';

export interface MissingOptions {
  /** Source values that are legitimately identical in every language (brand names, "OK"). */
  allowIdentical?: Set<string>;
}

export function findMissing(
  sourceLocale: string,
  source: LocaleStrings,
  locale: string,
  target: LocaleStrings,
  opts: MissingOptions = {},
): LocaleMissing {
  const sameLanguageAsSource = language(locale) === language(sourceLocale);
  const result: LocaleMissing = { locale, sameLanguageAsSource, absent: [], empty: [], likelyUntranslated: [], extra: [] };

  for (const [key, sourceValue] of source) {
    const value = target.get(key);
    if (value === undefined) result.absent.push(key);
    else if (!value.trim() && sourceValue.trim()) result.empty.push(key);
    else if (
      !sameLanguageAsSource &&
      value === sourceValue &&
      !isInvariant(sourceValue) &&
      !opts.allowIdentical?.has(sourceValue)
    ) {
      result.likelyUntranslated.push(key);
    }
  }
  for (const key of target.keys()) {
    if (!source.has(key)) result.extra.push(key);
  }
  return result;
}

/**
 * Strings that would normally be the same in any language: placeholders only,
 * numbers, codes (SAP, CHEP, EUR, B1208A), URLs, punctuation, or tiny fragments.
 */
export function isInvariant(value: string): boolean {
  const text = stripPlaceholders(value).trim();
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length <= 2) return true;
  // A single upper-case token that is short (SAP, EUR, POD) or contains a digit (B1208A).
  // Longer all-caps words (CANCEL, SUBMIT) are still translatable.
  if (!/^[\p{Lu}\p{N}_\-./:#]+$/u.test(text)) return false;
  return letters.length <= 4 || /\p{N}/u.test(text);
}

const language = (locale: string) => locale.split('-')[0];
