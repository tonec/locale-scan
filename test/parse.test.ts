import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localeFromFilename } from '../src/parse/detect.js';
import { loadLocaleDir } from '../src/parse/index.js';
import { flattenJson } from '../src/parse/json.js';
import { fixture } from './helpers.js';

describe('flattenJson', () => {
  it('flattens nested objects and keeps already-dotted flat keys', () => {
    const { strings } = flattenJson({ a: { b: 'x', 'c.d': 'y' }, 'e.f': 'z' });
    expect([...strings]).toEqual([
      ['a.b', 'x'],
      ['a.c.d', 'y'],
      ['e.f', 'z'],
    ]);
  });

  it('records non-string leaves instead of failing', () => {
    const { strings, skipped } = flattenJson({ a: 1, b: null, c: ['x'], d: 'ok' });
    expect([...strings.keys()]).toEqual(['d']);
    expect(skipped).toEqual([
      { key: 'a', type: 'number' },
      { key: 'b', type: 'null' },
      { key: 'c', type: 'array' },
    ]);
  });

  it('supports a custom separator and prefix', () => {
    expect([...flattenJson({ a: { b: 'x' } }, ':', 'ns').strings.keys()]).toEqual(['ns:a:b']);
  });
});

describe('localeFromFilename', () => {
  it.each([
    ['en.json', 'en'],
    ['en-GB.json', 'en-gb'],
    ['pt_BR.json', 'pt-br'],
    ['zh-Hans-CN.json', 'zh-hans-cn'],
    ['package.json', undefined],
    ['messages.json', undefined],
  ])('%s -> %s', (file, expected) => {
    expect(localeFromFilename(file)).toBe(expected);
  });
});

describe('loadLocaleDir', () => {
  it('loads one flat file per locale', async () => {
    const set = await loadLocaleDir(fixture('flat'));
    expect([...set.locales.keys()]).toEqual(['de', 'en-gb', 'en']);
    expect(set.locales.get('en')!.get('pallets.dehire')).toBe('De-hire pallets');
  });

  it('loads <locale>/<namespace>.json with namespace-prefixed keys', async () => {
    const set = await loadLocaleDir(fixture('nested'));
    expect([...set.locales.get('en')!.keys()]).toEqual([
      'common.actions.save',
      'common.actions.cancel',
      'common.actions.cancel_caps',
      'orders.title',
      'orders.status.open',
      'orders.status.closed',
    ]);
    expect(set.warnings.map((w) => w.key)).toEqual(['common.count', 'common.tags']);
  });

  it('warns on invalid JSON and fails when nothing loads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'locale-scan-'));
    await writeFile(path.join(dir, 'en.json'), '{ nope');
    await writeFile(path.join(dir, 'de.json'), '{"a":"b"}');
    const set = await loadLocaleDir(dir);
    expect(set.warnings[0]!.message).toMatch(/Invalid JSON/);
    expect([...set.locales.keys()]).toEqual(['de']);

    const empty = await mkdtemp(path.join(tmpdir(), 'locale-scan-'));
    await expect(loadLocaleDir(empty)).rejects.toThrow(/No locale files/);
  });
});
