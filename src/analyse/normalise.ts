import type { VariantKind } from '../types.js';

/**
 * Placeholders and markup that carry no translatable meaning:
 * {V1} {{count}} ${name} %{name} %s %1$d <br /> <a href="..."> &nbsp;
 */
const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}|[$%]\{\s*[\w.]+\s*\}|\{\s*[\w.]+\s*\}|%(?:\d+\$)?[sdif@]|<\/?[a-z][^>]*>|&[a-z]+;|&#\d+;/gi;

/** Private-use char standing in for a masked placeholder; survives punctuation stripping. */
export const PLACEHOLDER_MARK = '\uE000';

type Stage = { kind: VariantKind; apply: (s: string) => string };

/**
 * Applied cumulatively, in order. Each stage removes one kind of difference, so
 * a group of raw values that only merges at stage N differs by that stage's kind.
 */
export const STAGES: Stage[] = [
  { kind: 'whitespace', apply: (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim() },
  {
    kind: 'placeholder',
    apply: (s) => s.replace(PLACEHOLDER_RE, (m) => (m.startsWith('<') || m.startsWith('&') ? ' ' : PLACEHOLDER_MARK)).replace(/\s+/g, ' ').trim(),
  },
  { kind: 'casing', apply: (s) => s.toLowerCase() },
  {
    kind: 'punctuation',
    apply: (s) => s.replace(/[^\p{L}\p{N}\p{M}\uE000]+/gu, ' ').trim(),
  },
];

export function normalise(value: string): string {
  let s = value;
  for (const stage of STAGES) s = stage.apply(s);
  return s;
}

/** Which kinds of difference separate a set of distinct raw values that share a normalised form. */
export function variantKinds(values: string[]): VariantKind[] {
  const kinds: VariantKind[] = [];
  let current = values;
  for (const stage of STAGES) {
    const next = current.map(stage.apply);
    if (new Set(next).size < new Set(current).size) kinds.push(stage.kind);
    current = next;
  }
  return kinds;
}

/** Strip placeholders/markup entirely (for "is there any translatable text left?" checks). */
export function stripPlaceholders(value: string): string {
  return value.replace(PLACEHOLDER_RE, ' ').replace(/https?:\/\/\S+/g, ' ');
}
