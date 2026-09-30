import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProvider,
  DEFAULT_DEFINE_MODELS,
  DEFINITION_JSON_SCHEMA,
  defineTerms,
  SYSTEM,
  type DefinitionProvider,
} from '../src/vocab/define.js';
import { claudeCodeProvider, type Runner } from '../src/vocab/providers/claude-code.js';
import { geminiProvider, type GeminiClient, type GeminiResponse } from '../src/vocab/providers/gemini.js';
import type { ConceptDefinition, TermResult } from '../src/vocab/types.js';
import { strings } from './helpers.js';

const VALID = {
  ambiguous: true,
  senses: [
    { label: 'issue (dispatch)', definition: 'Pallets sent out to a customer.', exampleKeys: ['orders.issue_date'] },
    { label: 'issue (problem)', definition: 'A problem reported to support.', exampleKeys: ['support.issue'] },
  ],
  translatorNote: 'Do not translate as "problem" on order screens.',
  confidence: 'high',
};

function fakeClient(response: GeminiResponse | Error) {
  const generateContent = vi.fn(async (_params: unknown) => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { client: { models: { generateContent } } as GeminiClient, generateContent };
}

describe('gemini provider', () => {
  it('requests schema-constrained JSON and returns the parsed definition', async () => {
    const { client, generateContent } = fakeClient({ text: JSON.stringify(VALID), candidates: [{ finishReason: 'STOP' }] });
    const def = await geminiProvider('gemini-test', client).define('system text', 'prompt text');
    expect(def).toEqual({ ...VALID, model: 'gemini-test' });

    const params = generateContent.mock.calls[0]![0] as Record<string, any>;
    expect(params.model).toBe('gemini-test');
    expect(params.contents).toBe('prompt text');
    expect(params.config.systemInstruction).toBe('system text');
    expect(params.config.responseMimeType).toBe('application/json');
    expect(params.config.responseJsonSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['senses']) });
    expect(params.config.responseJsonSchema).not.toHaveProperty('$schema');
  });

  it.each([
    [{ text: 'not json', candidates: [{ finishReason: 'STOP' }] }, /invalid JSON/],
    [{ text: JSON.stringify({ ...VALID, senses: [] }) }, /did not match the schema/],
    [{ text: JSON.stringify({ ...VALID, confidence: 'certain' }) }, /did not match the schema/],
    [{ text: '', candidates: [{ finishReason: 'SAFETY' }] }, /stopped early \(finishReason: SAFETY\)/],
    [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, /blocked the prompt \(PROHIBITED_CONTENT/],
    [{ candidates: [{ finishReason: 'STOP' }] }, /no text/],
  ])('rejects bad responses clearly (%#)', async (response, message) => {
    const { client } = fakeClient(response as GeminiResponse);
    await expect(geminiProvider('g', client).define('s', 'p')).rejects.toThrow(message);
  });

  describe('without an API key', () => {
    const saved = { g: process.env.GEMINI_API_KEY, k: process.env.GOOGLE_API_KEY };
    afterEach(() => {
      process.env.GEMINI_API_KEY = saved.g;
      process.env.GOOGLE_API_KEY = saved.k;
      if (saved.g === undefined) delete process.env.GEMINI_API_KEY;
      if (saved.k === undefined) delete process.env.GOOGLE_API_KEY;
    });

    it('explains which variable to set', async () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      await expect(createProvider('gemini')).rejects.toThrow(/Set GEMINI_API_KEY/);
    });
  });

  it('createProvider picks the provider and its default model', async () => {
    process.env.GEMINI_API_KEY ??= 'test-key-not-used';
    const g = await createProvider('gemini');
    expect([g.name, g.model]).toEqual(['gemini', DEFAULT_DEFINE_MODELS.gemini]);
    expect((await createProvider('gemini', 'gemini-3-flash-preview')).model).toBe('gemini-3-flash-preview');
  });
});

describe('claude-code provider', () => {
  const ok = (body: object) => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
  function fakeRunner(result: ReturnType<typeof ok> | Error) {
    const calls: { args: string[]; stdin: string }[] = [];
    const run: Runner = async (args, stdin) => {
      calls.push({ args, stdin });
      if (args[0] === '--version') return { code: 0, stdout: '2.1.285 (Claude Code)', stderr: '' };
      if (result instanceof Error) throw result;
      return result;
    };
    return { run, calls };
  }

  it('runs claude -p with the schema, no tools, and returns the structured output', async () => {
    const { run, calls } = fakeRunner(
      ok({ type: 'result', subtype: 'success', is_error: false, structured_output: VALID, modelUsage: { 'claude-opus-5-5': {} } }),
    );
    const provider = await claudeCodeProvider('opus', run);
    const def = await provider.define('system text', 'prompt text');
    expect(def).toEqual({ ...VALID, model: 'claude-opus-5-5' });

    const { args, stdin } = calls[1]!;
    expect(stdin).toBe('prompt text');
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args[0]).toBe('-p');
    expect(flag('--output-format')).toBe('json');
    expect(flag('--model')).toBe('opus');
    expect(flag('--system-prompt')).toBe('system text');
    expect(JSON.parse(flag('--json-schema')!)).toEqual(DEFINITION_JSON_SCHEMA);
    expect(flag('--tools')).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
  });

  it.each([
    [ok({ subtype: 'error_max_turns', is_error: true, result: 'ran out of turns' }), /returned error_max_turns: ran out/],
    [ok({ subtype: 'success', is_error: true, api_error_status: 429, result: 'rate limited' }), /API status 429/],
    [ok({ subtype: 'success', is_error: false, structured_output: { ...VALID, senses: [] } }), /did not match the schema/],
    [{ code: 1, stdout: '', stderr: 'Not logged in' }, /claude exited with 1: Not logged in/],
  ])('rejects failures clearly (%#)', async (result, message) => {
    const provider = await claudeCodeProvider('opus', fakeRunner(result).run);
    await expect(provider.define('s', 'p')).rejects.toThrow(message);
  });

  it('fails fast when the CLI is missing', async () => {
    const missing: Runner = async () => {
      throw new Error('spawn claude ENOENT');
    };
    await expect(claudeCodeProvider('opus', missing)).rejects.toThrow(/Claude Code CLI not available \(spawn claude ENOENT\)/);
  });
});

describe('defineTerms', () => {
  const term = (name: string): TermResult => ({
    term: name,
    surfaces: {},
    df: 10,
    seeded: false,
    zipf: 5,
    labelShare: 0.5,
    keptEnglishShare: 0,
    tier: 'ambiguous',
    localesEvaluated: 3,
    localesFlagged: 3,
    consistency: 0.5,
    perLocale: [],
  });
  const stub = (name: 'claude' | 'gemini') => {
    const define = vi.fn(async (_system: string, _prompt: string): Promise<ConceptDefinition> => ({ ...VALID, confidence: 'high', model: `${name}-m` }));
    return { provider: { name, model: `${name}-m`, define } as DefinitionProvider, define };
  };

  it('passes the shared system prompt and caches per provider', async () => {
    const cachePath = path.join(await mkdtemp(path.join(tmpdir(), 'locale-scan-')), 'defs.json');
    const common = { domain: 'pallet portal', source: strings({}), cachePath };

    const gemini = stub('gemini');
    const first = await defineTerms([term('issue'), term('stock')], { ...common, provider: gemini.provider });
    expect([...first.keys()].sort()).toEqual(['issue', 'stock']);
    expect(gemini.define).toHaveBeenCalledTimes(2);
    expect(gemini.define.mock.calls[0]![0]).toBe(SYSTEM);

    await defineTerms([term('issue')], { ...common, provider: gemini.provider });
    expect(gemini.define).toHaveBeenCalledTimes(2); // cache hit

    const claude = stub('claude');
    await defineTerms([term('issue')], { ...common, provider: claude.provider });
    expect(claude.define).toHaveBeenCalledTimes(1); // different provider, separate entry
  });

  it('names the provider and term when a call fails', async () => {
    const cachePath = path.join(await mkdtemp(path.join(tmpdir(), 'locale-scan-')), 'defs.json');
    const provider: DefinitionProvider = { name: 'gemini', model: 'g', define: async () => { throw new Error('quota'); } };
    await expect(defineTerms([term('issue')], { provider, domain: 'd', source: strings({}), cachePath })).rejects.toThrow(
      'gemini (g) failed on "issue": quota',
    );
  });
});
