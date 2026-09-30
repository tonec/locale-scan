import { describe, expect, it } from 'vitest';
import { extractTerms, findOccurrences, lemma, words } from '../src/vocab/terms.js';
import { strings } from './helpers.js';

describe('lemma', () => {
  it.each([
    ['Pallets', 'pallet'],
    ['deliveries', 'delivery'],
    ['boxes', 'box'],
    ['statuses', 'status'],
    ['Dispatches', 'dispatch'],
    ['process', 'process'],
    ['status', 'status'],
    ['POD', 'pod'],
    ['CHEP’s', "chep's"],
  ])('%s -> %s', (w, expected) => expect(lemma(w)).toBe(expected));
});

describe('words', () => {
  it('drops placeholders and markup, keeps hyphenated words', () => {
    expect(words('De-hire {V1} pallets<br />now')).toEqual(['De-hire', 'pallets', 'now']);
  });
});

describe('extractTerms', () => {
  const source = strings({
    a: 'Issue date',
    b: 'Issue pallets to customer',
    c: 'Issues & returns',
    d: 'Pallet issue report',
    e: 'Please make sure the issue date is valid',
    f: 'Please make sure you select a depot',
    g: 'Please make sure the docket is signed',
    h: 'Docket number',
    i: 'Docket number',
    j: 'Enter a docket number',
    k: 'Docket number is required',
  });

  it('counts distinct strings and folds plurals', () => {
    const issue = extractTerms(source, { minDf: 2 }).find((t) => t.id === 'issue')!;
    expect(issue.df).toBe(5);
    expect(issue.surfaces).toEqual({ Issue: 2, Issues: 1, issue: 2 });
  });

  it('keeps label phrases, drops phrases never used as a label and stopwords', () => {
    const ids = extractTerms(source, { minDf: 2 }).map((t) => t.id);
    expect(ids).toContain('docket number');
    expect(ids).toContain('issue date');
    expect(ids).not.toContain('make sure');
    expect(ids).not.toContain('please');
    expect(ids).not.toContain('the');
  });

  it('drops a term covered by a longer phrase almost everywhere', () => {
    const ids = extractTerms(source, { minDf: 2 }).map((t) => t.id);
    // "number" only ever appears in "docket number"
    expect(ids).not.toContain('number');
    expect(ids).toContain('docket');
  });

  it('computes the share of label-like strings', () => {
    const docket = extractTerms(source, { minDf: 2 }).find((t) => t.id === 'docket')!;
    // 4 distinct strings; 3 are at most 4 words ("Docket number", "Enter a docket number",
    // "Docket number is required"); "Please make sure the docket is signed" is a sentence.
    expect(docket.labelShare).toBe(0.75);
  });

  it('always includes seeds, even unseen ones', () => {
    const terms = extractTerms(source, { minDf: 50, seeds: ['Issues', 'off-hire'] });
    expect(terms.map((t) => [t.id, t.df, t.seeded])).toEqual([
      ['issue', 5, true],
      ['off-hire', 0, true],
    ]);
  });
});

describe('findOccurrences', () => {
  it('finds multi-word matches', () => {
    expect(findOccurrences(['a', 'docket', 'number', 'docket'], ['docket', 'number'])).toEqual([1]);
    expect(findOccurrences(['a', 'docket', 'number', 'docket'], ['docket'])).toEqual([1, 3]);
  });
});
