import { describe, expect, it } from 'vitest';
import { normalise, PLACEHOLDER_MARK as P, variantKinds } from '../src/analyse/normalise.js';

describe('normalise', () => {
  it.each([
    ['  Submit   order. ', 'submit order'],
    ['SUBMIT ORDER', 'submit order'],
    ['Town/City', 'town city'],
    ['De-hire pallets', 'de hire pallets'],
    ['Docket {V1} was rejected.', `docket ${P} was rejected`],
    ['Docket %{docketNumber} was rejected', `docket ${P} was rejected`],
    ['Selected: {{count}} / %s', `selected ${P} ${P}`],
    ['Line one<br />Line&nbsp;two', 'line one line two'],
    ['Straße', 'straße'],
    ['...', ''],
  ])('%j -> %j', (input, expected) => {
    expect(normalise(input)).toBe(expected);
  });
});

describe('variantKinds', () => {
  it('names the stage at which values merge', () => {
    expect(variantKinds(['Submit order', 'SUBMIT ORDER'])).toEqual(['casing']);
    expect(variantKinds(['Submit order', 'Submit order.'])).toEqual(['punctuation']);
    expect(variantKinds(['Submit order', 'Submit  order '])).toEqual(['whitespace']);
    expect(variantKinds(['Selected: %{status}', 'Selected: %{location}'])).toEqual(['placeholder']);
    expect(variantKinds(['Corrections IN', 'Corrections In', 'CORRECTIONS-IN'])).toEqual(['casing', 'punctuation']);
  });
});
