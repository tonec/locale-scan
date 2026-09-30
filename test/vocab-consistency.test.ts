import { describe, expect, it } from 'vitest';
import type { AlignResult } from '../src/vocab/aligner.js';
import {
  isKeptEnglish,
  japaneseKey,
  measureConsistency,
  sameInflection,
  snapToScriptRuns,
} from '../src/vocab/consistency.js';
import { estimate, rankForGlossary } from '../src/vocab/estimate.js';
import { buildRequests, planLocales, type AlignRequest } from '../src/vocab/pairs.js';
import { renderVocabText } from '../src/vocab/report.js';
import type { Term } from '../src/vocab/types.js';
import type { LocaleSet } from '../src/types.js';
import { strings } from './helpers.js';

const term = (id: string, extra: Partial<Term> = {}): Term => ({
  id,
  lemmas: id.split(' '),
  surfaces: {},
  df: 10,
  seeded: false,
  labelShare: 0.5,
  zipf: 5,
  ...extra,
});

/** Build a request + alignment where source word `srcIdx` maps to target words [lo, hi]. */
function aligned(
  id: number,
  locale: string,
  src: string,
  tgt: string,
  srcIdx: number,
  span: [number, number] | null,
  score = 0.8,
): [AlignRequest, AlignResult] {
  const srcWords = src.split(' ');
  const tgtUnits = tgt.split(' ');
  const req: AlignRequest = { id, locale, lang: locale.split('-')[0]!, src, tgt, keys: [`k${id}`] };
  const res: AlignResult = {
    id,
    srcWords,
    tgtUnits,
    tgtStems: tgtUnits.map((u) => u.toLowerCase()),
    joiner: ' ',
    links: [],
    spans: srcWords.map((_, i) => (i === srcIdx ? span : null)),
    scores: srcWords.map((_, i) => (i === srcIdx && span ? score : null)),
  };
  return [req, res];
}

function run(pairs: [AlignRequest, AlignResult][], terms: Term[], locales = ['de', 'fr', 'pl']) {
  const groups = new Map(locales.map((l) => [l, [] as string[]]));
  return measureConsistency(terms, pairs.map((p) => p[0]), new Map(pairs.map((p) => [p[1].id, p[1]])), groups, {
    modelForLang: () => 'bert-base-multilingual-cased',
  });
}

/** n uses of "Issue X" in `locale`, rendered as the given words in order. */
function uses(locale: string, renderings: string[], start: number): [AlignRequest, AlignResult][] {
  return renderings.map((r, i) => aligned(start + i, locale, `Issue item${i}`, `${r} ding${i}`, 0, [0, 0]));
}

describe('measureConsistency', () => {
  it('flags a term split between two renderings in several languages as ambiguous', () => {
    const pairs = [
      ...uses('de', ['Ausgabe', 'Ausgabe', 'Ausgabe', 'Problem', 'Problem', 'Problem'], 0),
      ...uses('fr', ['Émission', 'Émission', 'Émission', 'Problème', 'Problème', 'Problème'], 100),
      ...uses('pl', ['Wydanie', 'Wydanie', 'Wydanie', 'Problem', 'Problem', 'Problem'], 200),
    ];
    const [r] = run(pairs, [term('issue')]);
    expect(r!.tier).toBe('ambiguous');
    expect(r!.localesFlagged).toBe(3);
    const de = r!.perLocale.find((p) => p.locale === 'de')!;
    expect(de.clusters.map((c) => [c.forms[0]!.text, c.count])).toEqual([
      ['Ausgabe', 3],
      ['Problem', 3],
    ]);
    expect(de.dominantShare).toBe(0.5);
  });

  it('calls the same split "phrasing" when the term is rarely a label', () => {
    const pairs = [
      ...uses('de', ['Ausgabe', 'Ausgabe', 'Ausgabe', 'Problem', 'Problem', 'Problem'], 0),
      ...uses('fr', ['Émission', 'Émission', 'Émission', 'Problème', 'Problème', 'Problème'], 100),
      ...uses('pl', ['Wydanie', 'Wydanie', 'Wydanie', 'Problem', 'Problem', 'Problem'], 200),
    ];
    expect(run(pairs, [term('issue', { labelShare: 0.05 })])[0]!.tier).toBe('phrasing');
  });

  it('merges inflections and treats one-off alternatives as noise', () => {
    const pairs = [
      ...uses('de', ['Palette', 'Paletten', 'Palette', 'Paletten', 'Palette', 'Kiste'], 0),
      ...uses('fr', ['palette', 'palettes', 'palette', 'palette', 'palette', 'palette'], 100),
      ...uses('pl', ['paleta', 'palety', 'palet', 'paleta', 'paleta', 'paleta'], 200),
    ];
    const [r] = run(pairs, [term('issue', { zipf: 3 })]);
    expect(r!.localesFlagged).toBe(0);
    expect(r!.tier).toBe('jargon');
    expect(r!.perLocale.find((p) => p.locale === 'pl')!.clusters).toHaveLength(1);
  });

  it('separates "left in English" from competing renderings', () => {
    const pairs = ['de', 'fr', 'pl'].flatMap((l, i) =>
      uses(l, ['Issue', 'Issue', 'Issue', 'Issue', 'Issue', 'Issue'], i * 100),
    );
    const [r] = run(pairs, [term('issue')]);
    expect(r!.keptEnglishShare).toBe(1);
    expect(r!.tier).toBe('keep-english');
  });

  it('ignores low-confidence and over-wide alignments', () => {
    const pairs = [
      aligned(1, 'de', 'Issue date', 'Ausgabe Datum', 0, [0, 0], 0.3),
      aligned(2, 'de', 'Issue date', 'a b c d e', 0, [0, 4]),
    ];
    const de = run(pairs, [term('issue')])[0]!.perLocale[0]!;
    expect(de.unaligned).toBe(2);
    expect(de.occurrences).toBe(0);
  });

  it('marks terms with too few aligned uses as insufficient', () => {
    expect(run(uses('de', ['Ausgabe'], 0), [term('issue')])[0]!.tier).toBe('insufficient');
  });
});

describe('helpers', () => {
  it('isKeptEnglish covers exact, partial and compound forms', () => {
    expect(isKeptEnglish('myCHEP', 'myCHEP', 'mychep')).toBe(true);
    expect(isKeptEnglish('CHEP', 'myCHEP', 'mychep')).toBe(true);
    expect(isKeptEnglish('Supportanfragen', 'support', 'support')).toBe(true);
    expect(isKeptEnglish('Unterstützung', 'support', 'support')).toBe(false);
    expect(isKeptEnglish('サポート', 'support', 'support')).toBe(false);
  });

  it('sameInflection merges endings but not different words', () => {
    expect(sameInflection('regiões', 'região')).toBe(true);
    expect(sameInflection('un', 'una')).toBe(true);
    expect(sameInflection('partnera', 'partner')).toBe(true);
    expect(sameInflection('ausgabe', 'problem')).toBe(false);
    expect(sameInflection('stock', 'saldo')).toBe(false);
    expect(sameInflection('a b', 'a')).toBe(false);
  });

  it('snapToScriptRuns completes katakana, kanji and Latin words', () => {
    const units = ['サ', 'ポート', 'に', '連絡', 'my', 'CH', 'EP'];
    expect(snapToScriptRuns(units, 1, 1, 'ja')).toEqual([0, 1]);
    expect(snapToScriptRuns(units, 5, 5, 'ja')).toEqual([4, 6]);
    expect(snapToScriptRuns(units, 3, 3, 'ja')).toEqual([3, 3]);
    expect(snapToScriptRuns(['ก', 'Audi', 't'], 1, 1, 'th')).toEqual([1, 2]);
    expect(snapToScriptRuns(units, 1, 1, 'de')).toEqual([1, 1]);
  });

  it('japaneseKey drops hiragana', () => {
    expect(japaneseKey('で回復する')).toBe('回復');
    expect(japaneseKey('の')).toBe('の');
  });
});

describe('planLocales / buildRequests', () => {
  const en = strings({ a: 'Issue date', b: 'Close', c: 'Issue {V1} failed' });
  const set: LocaleSet = {
    locales: new Map([
      ['en', en],
      ['en-gb', new Map(en)],
      ['de', strings({ a: 'Ausgabedatum', b: 'Schließen', c: 'Issue {V1} failed' })],
      ['de-de', strings({ a: 'Ausgabedatum', b: 'Schließen', c: 'Issue {V1} failed' })],
      ['fr', strings({ a: "Date d'émission", b: 'Fermer', c: 'Émission {V1} échouée' })],
    ]),
    files: new Map(),
    warnings: [],
  };

  it('folds byte-identical locales and skips same-language variants', () => {
    const plan = planLocales(set, 'en');
    expect([...plan.groups]).toEqual([
      ['de', ['de-de']],
      ['fr', []],
    ]);
    expect(plan.skipped).toEqual([{ locale: 'en-gb', reason: 'same language as source' }]);
    expect([...planLocales(set, 'en', ['fr']).groups.keys()]).toEqual(['fr']);
  });

  it('only aligns translated strings that contain a term, with placeholders removed', () => {
    const reqs = buildRequests(en, set, ['de', 'fr'], [term('issue')]);
    expect(reqs.map((r) => [r.locale, r.src, r.tgt])).toEqual([
      ['de', 'Issue date', 'Ausgabedatum'],
      ['fr', 'Issue date', "Date d'émission"],
      ['fr', 'Issue failed', 'Émission échouée'],
    ]);
  });
});

describe('estimate / report', () => {
  const pairs = [
    ...uses('de', ['Ausgabe', 'Ausgabe', 'Ausgabe', 'Problem', 'Problem', 'Problem'], 0),
    ...uses('fr', ['Émission', 'Émission', 'Émission', 'Problème', 'Problème', 'Problème'], 100),
    ...uses('pl', ['Wydanie', 'Wydanie', 'Wydanie', 'Problem', 'Problem', 'Problem'], 200),
  ];
  const terms = run(pairs, [term('issue', { df: 30 }), term('docket', { df: 12, zipf: 2 })]);

  it('counts tiers and glossary size by frequency', () => {
    const e = estimate(terms);
    expect(e.byTier.ambiguous).toBe(1);
    expect(e.byTier.jargon).toBe(1); // docket: no data, but rare in English
    expect(e.glossaryByMinDf).toEqual([
      { minDf: 5, terms: 2 },
      { minDf: 10, terms: 2 },
      { minDf: 25, terms: 1 },
      { minDf: 50, terms: 0 },
    ]);
    expect(rankForGlossary(terms).map((t) => t.term)).toEqual(['issue', 'docket']);
  });

  it('renders the estimate and term renderings', () => {
    const text = renderVocabText({
      source: 'en',
      localeGroups: { de: ['de-de'], fr: [], pl: [] },
      skippedLocales: [],
      alignment: { pairs: pairs.length, models: { '*': 'bert-base-multilingual-cased' } },
      estimate: estimate(terms),
      terms,
    });
    expect(text).toMatch(/Ambiguous +1 /);
    expect(text).toContain('dozens of concepts');
    expect(text).toMatch(/issue {2}\(30 strings, 3\/3 languages split/);
    expect(text).toContain('Ausgabe x3 · Problem x3');
  });
});
