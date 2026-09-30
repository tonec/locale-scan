import { rankForGlossary } from './estimate.js';
import type { TermLocaleStats, TermResult, VocabResult } from './types.js';

export interface VocabTextOptions {
  top?: number;
  /** Locales shown per term. */
  localesPerTerm?: number;
}

export function renderVocabText(r: VocabResult, opts: VocabTextOptions = {}): string {
  const top = opts.top ?? 20;
  const perTerm = opts.localesPerTerm ?? 5;
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  const aliases = Object.values(r.localeGroups).flat().length;
  const e = r.estimate;

  line(
    `locale-scan vocab: source "${r.source}", ${Object.keys(r.localeGroups).length} target locales` +
      (aliases ? ` (+${aliases} byte-identical aliases folded in)` : '') +
      (r.skippedLocales.length ? `, skipped ${r.skippedLocales.map((s) => s.locale).join(', ')} (same language)` : ''),
  );
  const models = Object.entries(r.alignment.models).map(([lang, m]) => (lang === '*' ? m : `${lang}: ${m}`));
  line(`Aligned ${n(r.alignment.pairs)} distinct string pairs (${models.join('; ')})`);
  line();
  line('VOCABULARY ESTIMATE');
  line(`  ${n(e.candidates)} candidate terms (words and 2-3 word phrases)`);
  line(`  Ambiguous   ${pad(n(e.byTier.ambiguous), 6)}  more than one rendering in a meaningful share of languages`);
  line(`  Jargon      ${pad(n(e.byTier.jargon), 6)}  rare in general English, consistently translated`);
  line(`  Keep in EN  ${pad(n(e.byTier['keep-english']), 6)}  mostly left in English (brand/product names, codes)`);
  line(`  Phrasing    ${pad(n(e.byTier.phrasing), 6)}  varies, but only inside sentences (grammar/style, not meaning)`);
  line(`  Stable      ${pad(n(e.byTier.stable), 6)}  common English, consistently translated`);
  line(`  Too little  ${pad(n(e.byTier.insufficient), 6)}  not enough aligned occurrences to judge`);
  line(
    `  Glossary-worthy (ambiguous + jargon): ` +
      e.glossaryByMinDf.map((g) => `${n(g.terms)} at >=${g.minDf} strings`).join(', '),
  );
  const core = e.glossaryByMinDf.find((g) => g.minDf === 10)?.terms ?? e.byTier.ambiguous + e.byTier.jargon;
  const scale = core < 100 ? 'dozens of' : core < 300 ? 'low hundreds of' : 'hundreds of';
  line(`  => the vocabulary step is ${scale} concepts (${n(core)} glossary-worthy terms used in 10+ strings),`);
  line(`     plus a do-not-translate list of ${n(e.byTier['keep-english'])}.`);

  const ranked = rankForGlossary(r.terms);
  const ambiguous = ranked.filter((t) => t.tier === 'ambiguous');
  if (ambiguous.length) {
    line();
    line(`MOST INCONSISTENT TERMS (${Math.min(top, ambiguous.length)} of ${n(ambiguous.length)})`);
    for (const t of ambiguous.slice(0, top)) termBlock(t, perTerm).forEach((l) => line(l));
  }
  const keep = r.terms.filter((t) => t.tier === 'keep-english').sort((a, b) => b.df - a.df);
  if (keep.length) {
    line();
    line(`KEEP IN ENGLISH (${n(keep.length)}): ${keep.slice(0, top * 2).map((t) => t.term).join(', ')}`);
  }
  const jargon = ranked.filter((t) => t.tier === 'jargon');
  if (jargon.length) {
    line();
    line(`JARGON (${Math.min(top, jargon.length)} of ${n(jargon.length)})`);
    for (const t of jargon.slice(0, top)) termBlock(t, Math.min(3, perTerm)).forEach((l) => line(l));
  }
  return out.join('\n') + '\n';
}

function termBlock(t: TermResult, perTerm: number): string[] {
  const lines: string[] = [];
  lines.push(
    `  ${t.term}  (${n(t.df)} strings, ${t.localesFlagged}/${t.localesEvaluated} languages split, ` +
      `consistency ${Math.round(t.consistency * 100)}%${t.zipf !== null ? `, zipf ${t.zipf.toFixed(1)}` : ''})`,
  );
  const shown = [...t.perLocale]
    .filter((p) => p.occurrences > 0)
    .sort((a, b) => Number(b.multiple) - Number(a.multiple) || a.dominantShare - b.dominantShare)
    .slice(0, perTerm);
  for (const p of shown) lines.push(`      ${pad(localeLabel(p), 10, true)} ${renderings(p)}`);
  if (t.definition) {
    for (const s of t.definition.senses) lines.push(`      > ${s.label}: ${s.definition}`);
    if (t.definition.translatorNote) lines.push(`      > note: ${t.definition.translatorNote}`);
  }
  return lines;
}

function renderings(p: TermLocaleStats): string {
  const parts = p.clusters.slice(0, 4).map((c) => `${c.keptEnglish ? `(English) ${c.forms[0]!.text}` : c.forms[0]!.text} x${c.count}`);
  if (p.clusters.length > 4) parts.push(`+${p.clusters.length - 4} more`);
  return parts.join(' · ');
}

const localeLabel = (p: TermLocaleStats) => (p.aliases.length ? `${p.locale}*` : p.locale);
const n = (x: number) => x.toLocaleString('en-US');
const pad = (text: string, width: number, left = false) => (left ? text.padEnd(width) : text.padStart(width));
