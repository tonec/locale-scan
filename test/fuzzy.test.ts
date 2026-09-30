import { describe, expect, it } from 'vitest';
import { findFuzzy, similarity } from '../src/analyse/fuzzy.js';
import { strings } from './helpers.js';

const valuesOf = (groups: ReturnType<typeof findFuzzy>) =>
  groups.map((g) => g.members.map((m) => m.value).sort());

describe('similarity', () => {
  it('is 1 - normalised edit distance', () => {
    expect(similarity('abcd', 'abcd')).toBe(1);
    expect(similarity('abcd', 'abce')).toBe(0.75);
  });

  it('returns 0 once the distance exceeds the budget', () => {
    expect(similarity('abcdefgh', 'zzzzzzzz', 0.5)).toBe(0);
  });
});

describe('findFuzzy', () => {
  it('links small wording drift and reordered words', () => {
    const groups = findFuzzy(
      strings({
        a: 'Reverse transfer in',
        b: 'Reversed transfer in',
        c: 'Date submitted',
        d: 'Submitted date',
        e: 'Pallet exchange',
      }),
    );
    expect(valuesOf(groups)).toEqual([
      ['Date submitted', 'Submitted date'],
      ['Reverse transfer in', 'Reversed transfer in'],
    ]);
    expect(groups[0]!.minSimilarity).toBe(1);
    expect(groups[1]!.minSimilarity).toBeGreaterThanOrEqual(0.85);
  });

  it('matches single-word strings via trigrams when similar enough', () => {
    const groups = findFuzzy(strings({ a: 'Consignment', b: 'Consignments', c: 'Collection' }));
    expect(valuesOf(groups)).toEqual([['Consignment', 'Consignments']]);
  });

  it('does not report strings that differ only in numbers', () => {
    expect(findFuzzy(strings({ a: 'Condition grade 1', b: 'Condition grade 2' }))).toEqual([]);
  });

  it('does not repeat exact duplicates or normalised variants as separate nodes', () => {
    const groups = findFuzzy(strings({ a: 'Submit order', b: 'SUBMIT ORDER', c: 'Submit orders' }));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toEqual([
      { value: 'Submit order', keys: ['a'] },
      { value: 'SUBMIT ORDER', keys: ['b'] },
      { value: 'Submit orders', keys: ['c'] },
    ]);
  });

  it('respects the threshold and max length', () => {
    const s = strings({ a: 'De-hire pallets', b: 'Off-hire pallets' });
    expect(findFuzzy(s, { threshold: 0.95 })).toEqual([]);
    expect(findFuzzy(s, { threshold: 0.7 })).toHaveLength(1);
    expect(findFuzzy(s, { threshold: 0.7, maxLength: 10 })).toEqual([]);
  });

  it('handles ~10k strings quickly', () => {
    const words = ['pallet', 'crate', 'container', 'issue', 'return', 'dehire', 'transfer', 'exchange', 'collection',
      'depot', 'customer', 'docket', 'invoice', 'balance', 'report', 'order', 'damaged', 'lost', 'grade', 'pool'];
    const s = new Map<string, string>();
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 10_000; i++) {
      const len = 2 + Math.floor(rand() * 8);
      s.set(`k${i}`, Array.from({ length: len }, () => words[Math.floor(rand() * words.length)]).join(' '));
    }
    const start = performance.now();
    findFuzzy(s);
    expect(performance.now() - start).toBeLessThan(10_000);
  });
});
