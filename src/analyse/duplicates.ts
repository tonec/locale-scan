import type { DuplicateGroup, LocaleStrings, VariantGroup } from '../types.js';
import { normalise, variantKinds } from './normalise.js';

/** Groups of keys whose values are byte-identical. Blank values are ignored. */
export function findDuplicates(strings: LocaleStrings): DuplicateGroup[] {
  const byValue = new Map<string, string[]>();
  for (const [key, value] of strings) {
    if (!value.trim()) continue;
    const keys = byValue.get(value);
    if (keys) keys.push(key);
    else byValue.set(value, [key]);
  }
  return [...byValue]
    .filter(([, keys]) => keys.length > 1)
    .map(([value, keys]) => ({ value, keys }))
    .sort((a, b) => b.keys.length - a.keys.length || a.value.localeCompare(b.value));
}

/**
 * Groups of distinct values that become equal after normalisation
 * (casing / whitespace / punctuation / placeholder differences).
 */
export function findVariants(strings: LocaleStrings): VariantGroup[] {
  const byNorm = new Map<string, Map<string, string[]>>();
  for (const [key, value] of strings) {
    const norm = normalise(value);
    if (!norm) continue;
    let values = byNorm.get(norm);
    if (!values) byNorm.set(norm, (values = new Map()));
    const keys = values.get(value);
    if (keys) keys.push(key);
    else values.set(value, [key]);
  }

  const groups: VariantGroup[] = [];
  for (const [norm, values] of byNorm) {
    if (values.size < 2) continue;
    groups.push({
      normalised: norm,
      kinds: variantKinds([...values.keys()]),
      members: [...values].map(([value, keys]) => ({ value, keys })),
    });
  }
  return groups.sort((a, b) => b.members.length - a.members.length || a.normalised.localeCompare(b.normalised));
}
