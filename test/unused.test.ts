import { describe, expect, it } from 'vitest';
import { findUnused } from '../src/analyse/unused.js';
import { fixture } from './helpers.js';

const keys = [
  'orders.issue_date',
  'orders.submit',
  'orders.submit_btn',
  'nav.issues_returns',
  'pool.exchange',
  'error.ZPOOL.001.message',
  'level.one',
  'pallets.dehire',
];

describe('findUnused', () => {
  it('finds keys never used as a literal, treating runtime-built prefixes as dynamic', async () => {
    const r = await findUnused(keys, fixture('src'));
    expect(r.scannedFiles).toBe(2); // node_modules is skipped
    // error.${code} and 'level.' + code make those keys "possibly dynamic"
    expect(r.skippedDynamic).toBe(2);
    expect(r.unused).toEqual(['orders.submit_btn', 'pallets.dehire']);
  });

  it('accepts manual dynamic prefixes', async () => {
    const r = await findUnused(keys, fixture('src'), { dynamicPrefixes: ['pallets.'] });
    expect(r.unused).toEqual(['orders.submit_btn']);
  });
});
