import { describe, expect, it } from 'vitest';
import { findDuplicates, findVariants } from '../src/analyse/duplicates.js';
import { strings } from './helpers.js';

const source = strings({
  a: 'Submit order',
  b: 'Submit order',
  c: 'SUBMIT ORDER',
  d: 'Submit order.',
  e: 'Pallet exchange',
  f: '',
  g: '',
  h: '---',
  i: '...',
});

describe('findDuplicates', () => {
  it('groups identical non-blank values', () => {
    expect(findDuplicates(source)).toEqual([{ value: 'Submit order', keys: ['a', 'b'] }]);
  });
});

describe('findVariants', () => {
  it('groups distinct values that share a normalised form, keeping exact duplicates together', () => {
    expect(findVariants(source)).toEqual([
      {
        normalised: 'submit order',
        kinds: ['casing', 'punctuation'],
        members: [
          { value: 'Submit order', keys: ['a', 'b'] },
          { value: 'SUBMIT ORDER', keys: ['c'] },
          { value: 'Submit order.', keys: ['d'] },
        ],
      },
    ]);
  });

  it('ignores values that normalise to nothing (punctuation only)', () => {
    expect(findVariants(strings({ a: '---', b: '...' }))).toEqual([]);
  });
});
