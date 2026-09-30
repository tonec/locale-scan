import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { fixture } from './helpers.js';

async function run(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

describe('cli', () => {
  it('prints a text summary', async () => {
    const { code, stdout } = await run(fixture('flat'));
    expect(code).toBe(0);
    expect(stdout).toContain('source "en" (18 keys), 3 locales');
    expect(stdout).toMatch(/% of source strings are duplicates or casing\/punctuation variants \(4 of 18 keys\)/);
    expect(stdout).toContain('Exact duplicates');
    expect(stdout).toMatch(/en-gb\s+0\s+0\s+n\/a \(same lang\)/);
  });

  it('emits a JSON report whose summary matches the findings', async () => {
    const { code, stdout } = await run(fixture('flat'), '--format', 'json');
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.reportVersion).toBe(1);
    expect(report.summary.duplicateGroups).toBe(report.duplicates.length);
    const de = report.missing.find((m: { locale: string }) => m.locale === 'de');
    expect(de).toMatchObject({ absent: ['pool.note'], empty: ['orders.issued_date'], extra: ['legacy.unused'] });
    expect(de.likelyUntranslated).toEqual(['orders.date_of_issue', 'pallets.dehire', 'pool.exchange']);
  });

  it('writes JSON to --out with --format both', async () => {
    const out = path.join(await mkdtemp(path.join(tmpdir(), 'locale-scan-')), 'nested', 'report.json');
    const { code, stdout, stderr } = await run(fixture('flat'), '--format', 'both', '--out', out);
    expect(code).toBe(0);
    expect(stdout).toContain('REDUNDANCY');
    expect(stderr).toContain(out);
    expect(JSON.parse(await readFile(out, 'utf8')).source).toBe('en');
  });

  it('reads --allow-identical and scans --src', async () => {
    const allow = path.join(await mkdtemp(path.join(tmpdir(), 'locale-scan-')), 'allow.txt');
    await writeFile(allow, 'Pallet exchange\nDe-hire pallets\n');
    const { stdout } = await run(fixture('flat'), '--format', 'json', '--allow-identical', allow, '--src', fixture('src'));
    const report = JSON.parse(stdout);
    expect(report.missing.find((m: { locale: string }) => m.locale === 'de').likelyUntranslated).toEqual(['orders.date_of_issue']);
    expect(report.unused.unused).toContain('pallets.offhire');
  });

  it('exits 1 when a --fail-on check triggers, 0 otherwise', async () => {
    expect((await run(fixture('flat'), '--fail-on', 'missing')).code).toBe(1);
    expect((await run(fixture('flat'), '--fail-on', 'duplicates,variants')).code).toBe(1);
    expect((await run(fixture('flat'), '--fail-on', 'unused')).code).toBe(0); // no --src given
  });

  it('exits 2 on usage errors', async () => {
    expect((await run()).code).toBe(2);
    expect((await run(fixture('flat'), '--format', 'xml')).code).toBe(2);
    expect((await run(fixture('flat'), '--format', 'both')).code).toBe(2);
    expect((await run(fixture('flat'), '--fail-on', 'nope')).code).toBe(2);
    expect((await run(fixture('flat'), '--source', 'xx')).stderr).toMatch(/Source locale "xx" not found/);
    expect((await run(fixture('flat'), '--bogus')).code).toBe(2);
  });

  it('supports --no-fuzzy and nested layouts', async () => {
    const { code, stdout } = await run(fixture('nested'), '--no-fuzzy');
    expect(code).toBe(0);
    expect(stdout).toContain('Fuzzy near-duplicates  (disabled)');
    expect(stdout).toContain('WARNINGS (2)');
  });
});
