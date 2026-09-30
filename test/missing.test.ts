import { describe, expect, it } from 'vitest';
import { findMissing, isInvariant } from '../src/analyse/missing.js';
import { strings } from './helpers.js';

const en = strings({
  title: 'Pallet exchange',
  dehire: 'De-hire pallets',
  offhire: 'Off-hire pallets',
  currency: 'EUR',
  docket: '{V1}',
  empty: '',
});

describe('findMissing', () => {
  it('splits absent, empty, likely-untranslated and extra keys', () => {
    const de = strings({ title: 'Pallet exchange', dehire: '  ', currency: 'EUR', docket: '{V1}', empty: '', legacy: 'x' });
    expect(findMissing('en', en, 'de', de)).toEqual({
      locale: 'de',
      sameLanguageAsSource: false,
      absent: ['offhire'],
      empty: ['dehire'],
      likelyUntranslated: ['title'],
      extra: ['legacy'],
    });
  });

  it('does not flag identical text for regional variants of the source language', () => {
    const result = findMissing('en', en, 'en-gb', new Map(en));
    expect(result.sameLanguageAsSource).toBe(true);
    expect(result.likelyUntranslated).toEqual([]);
  });

  it('honours the allow-identical list', () => {
    const fr = strings({ ...Object.fromEntries(en), dehire: 'Déclarer des palettes' });
    const result = findMissing('en', en, 'fr', fr, { allowIdentical: new Set(['Pallet exchange']) });
    expect(result.likelyUntranslated).toEqual(['offhire']);
  });
});

describe('isInvariant', () => {
  it.each(['EUR', 'CHEP', 'POD', 'B1208A', '09:00-10:00', 'SS-ORDR-API-004', '{V1} {V2}', 'OK', 'Fr', '<br />', 'https://example.com'])(
    '%j is invariant',
    (v) => expect(isInvariant(v)).toBe(true),
  );
  it.each(['Pallet exchange', 'CANCEL', 'SUBMIT ORDER', 'Docket {V1} rejected', 'Oman'])('%j is translatable', (v) =>
    expect(isInvariant(v)).toBe(false),
  );
});
