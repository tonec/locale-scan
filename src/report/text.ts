import type { ScanResult, ValueKeys, VariantKind } from '../types.js';

export interface TextOptions {
  /** How many groups to list per section. */
  top?: number;
  fuzzyThreshold?: number;
  fuzzyEnabled?: boolean;
}

export function renderText(r: ScanResult, opts: TextOptions = {}): string {
  const top = opts.top ?? 10;
  const s = r.summary;
  const out: string[] = [];
  const line = (text = '') => out.push(text);

  line(`locale-scan: source "${r.source}" (${n(r.sourceKeyCount)} keys), ${r.locales.length} locales`);
  line();
  line('REDUNDANCY (source locale)');
  line(
    `  ${s.duplicateOrVariantPercent}% of source strings are duplicates or casing/punctuation variants ` +
      `(${n(s.duplicateOrVariantKeys)} of ${n(r.sourceKeyCount)} keys)`,
  );
  if (opts.fuzzyEnabled !== false) {
    line(`  ${s.redundantPercent}% including fuzzy near-duplicates (${n(s.redundantKeys)} keys)`);
  }
  line(`  Exact duplicates       ${pad(n(s.duplicateKeys), 7)} keys in ${n(s.duplicateGroups)} groups`);
  line(`  Normalised variants    ${pad(n(s.variantKeys), 7)} keys in ${n(s.variantGroups)} groups${kindBreakdown(r)}`);
  if (opts.fuzzyEnabled === false) line('  Fuzzy near-duplicates  (disabled)');
  else
    line(
      `  Fuzzy near-duplicates  ${pad(n(s.fuzzyKeys), 7)} keys in ${n(s.fuzzyGroups)} groups` +
        (opts.fuzzyThreshold ? ` (similarity >= ${opts.fuzzyThreshold})` : ''),
    );
  line(`  Merging exact duplicates and variants would remove ${n(s.collapsibleKeys)} keys.`);

  if (r.duplicates.length) {
    line();
    line(`Top exact duplicates (${Math.min(top, r.duplicates.length)} of ${n(r.duplicates.length)})`);
    for (const g of r.duplicates.slice(0, top)) {
      line(`  x${g.keys.length}  ${quote(g.value)}`);
      line(`       ${keyList(g.keys)}`);
    }
  }
  if (r.variants.length) {
    line();
    line(`Top normalised variants (${Math.min(top, r.variants.length)} of ${n(r.variants.length)})`);
    for (const g of r.variants.slice(0, top)) {
      line(`  [${g.kinds.join(', ')}]`);
      memberLines(g.members).forEach((l) => line(l));
    }
  }
  if (r.fuzzy.length) {
    line();
    line(`Top fuzzy near-duplicates (${Math.min(top, r.fuzzy.length)} of ${n(r.fuzzy.length)})`);
    for (const g of r.fuzzy.slice(0, top)) {
      line(g.minSimilarity === 1 ? '  [same words, different order]' : `  [similarity >= ${g.minSimilarity}]`);
      memberLines(g.members).forEach((l) => line(l));
    }
  }

  line();
  line(`MISSING TRANSLATIONS (vs ${r.source})`);
  line(`  ${pad('locale', 8, true)} ${pad('absent', 8)} ${pad('empty', 8)} ${pad('untranslated', 20)} ${pad('extra', 7)}`);
  for (const m of r.missing) {
    const untranslated = m.sameLanguageAsSource
      ? 'n/a (same lang)'
      : `${n(m.likelyUntranslated.length)} (${pct(m.likelyUntranslated.length, r.sourceKeyCount)})`;
    line(
      `  ${pad(m.locale, 8, true)} ${pad(n(m.absent.length), 8)} ${pad(n(m.empty.length), 8)} ${pad(untranslated, 20)} ${pad(n(m.extra.length), 7)}`,
    );
  }
  line('  "untranslated" = identical to the source text, excluding codes, numbers and placeholder-only strings.');

  if (r.unused) {
    line();
    line('UNUSED KEYS');
    line(
      `  ${n(r.unused.unused.length)} of ${n(r.sourceKeyCount)} keys not found in ${n(r.unused.scannedFiles)} files ` +
        `(${n(r.unused.skippedDynamic)} more skipped as possibly built dynamically)`,
    );
    for (const k of r.unused.unused.slice(0, top)) line(`  ${k}`);
    if (r.unused.unused.length > top) line(`  ... +${n(r.unused.unused.length - top)} more`);
  }

  if (r.warnings.length) {
    line();
    line(`WARNINGS (${n(r.warnings.length)})`);
    for (const w of r.warnings.slice(0, top)) line(`  ${w.locale}${w.key ? ` ${w.key}` : ''}: ${w.message}`);
    if (r.warnings.length > top) line(`  ... +${n(r.warnings.length - top)} more`);
  }
  return out.join('\n') + '\n';
}

function kindBreakdown(r: ScanResult): string {
  const counts = new Map<VariantKind, number>();
  for (const g of r.variants) for (const k of g.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  if (!counts.size) return '';
  return ` (${[...counts].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${n(c)}`).join(', ')})`;
}

function memberLines(members: ValueKeys[]): string[] {
  return members.map((m) => `    ${quote(m.value)}  <- ${keyList(m.keys, 3)}`);
}

function keyList(keys: string[], max = 4): string {
  const shown = keys.slice(0, max).join(', ');
  return keys.length > max ? `${shown}, ... +${keys.length - max}` : shown;
}

function quote(value: string, max = 70): string {
  const flat = value.replace(/\s+/g, ' ');
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
}

const n = (x: number) => x.toLocaleString('en-US');
const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '0%');
const pad = (text: string, width: number, left = false) => (left ? text.padEnd(width) : text.padStart(width));
