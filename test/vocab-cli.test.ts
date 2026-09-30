import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { buildPrompt } from '../src/vocab/define.js';
import type { TermResult } from '../src/vocab/types.js';
import { fixture, strings } from './helpers.js';

async function run(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

describe('vocab command', () => {
  it('prints help', async () => {
    const { code, stdout } = await run('vocab', '--help');
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: locale-scan vocab');
    expect(stdout).toContain('claude-code  local Claude Code CLI');
    expect(stdout).toContain('--define-model');
    expect((await run('help', 'vocab')).stdout).toContain('--define');
  });

  it('rejects bad arguments', async () => {
    expect((await run('vocab')).code).toBe(2);
    expect((await run('vocab', fixture('flat'), '--min-df', '0')).code).toBe(2);
    expect((await run('vocab', fixture('flat'), '--model-for', 'th')).stderr).toMatch(/lang=model/);
    expect((await run('vocab', fixture('flat'), '--format', 'both')).stderr).toMatch(/requires --out/);
    expect((await run('vocab', fixture('flat'), '--provider', 'foo')).stderr).toMatch(/--provider must be one of claude, claude-code, gemini/);
  });

  it('reports a missing aligner Python clearly', async () => {
    const { code, stderr } = await run('vocab', fixture('flat'), '--min-df', '1', '--python', '/nonexistent/python');
    expect(code).toBe(2);
    expect(stderr).toMatch(/Aligner Python not found.*setup:aligner/);
  });

  it('keeps "scan" as the default command', async () => {
    expect((await run(fixture('flat'))).stdout).toContain('REDUNDANCY');
    expect((await run('scan', fixture('flat'))).stdout).toContain('REDUNDANCY');
  });
});

describe('define prompt', () => {
  it('includes renderings, example keys and their English strings', () => {
    const t: TermResult = {
      term: 'issue',
      surfaces: { Issue: 3 },
      df: 30,
      seeded: false,
      zipf: 5.2,
      labelShare: 0.6,
      keptEnglishShare: 0.1,
      tier: 'ambiguous',
      localesEvaluated: 3,
      localesFlagged: 3,
      consistency: 0.5,
      perLocale: [
        {
          locale: 'de',
          aliases: ['de-de'],
          occurrences: 6,
          unaligned: 0,
          dominantShare: 0.5,
          keptEnglishShare: 0,
          multiple: true,
          clusters: [
            { key: 'ausgab', count: 3, forms: [{ text: 'Ausgabe', count: 3 }], exampleKeys: ['orders.issue_date'], keptEnglish: false },
            { key: 'problem', count: 2, forms: [{ text: 'Problem', count: 2 }], exampleKeys: ['support.issue'], keptEnglish: false },
            { key: '=en', count: 1, forms: [{ text: 'Issue', count: 1 }], exampleKeys: ['nav.issue'], keptEnglish: true },
          ],
        },
      ],
    };
    const prompt = buildPrompt(t, {
      domain: 'pallet pooling portal',
      source: strings({ 'orders.issue_date': 'Issue date', 'support.issue': 'Report an issue', 'nav.issue': 'Issue' }),
    });
    expect(prompt).toContain('Product: pallet pooling portal');
    expect(prompt).toContain('- de: Ausgabe x3 [orders.issue_date]; Problem x2 [support.issue]; (left in English: Issue) x1 [nav.issue]');
    expect(prompt).toContain('- orders.issue_date: "Issue date"');
    expect(prompt).toContain('- support.issue: "Report an issue"');
  });
});
