import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LocaleStrings } from '../types.js';
import type { ConceptDefinition, TermResult } from './types.js';

export const PROVIDERS = ['claude', 'claude-code', 'gemini'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const DEFAULT_DEFINE_MODELS: Record<ProviderName, string> = {
  claude: 'claude-opus-5-5',
  // Claude Code CLI model alias: the latest Opus available on the user's plan.
  'claude-code': 'opus',
  gemini: 'gemini-3.1-pro-preview',
};

/** One LLM backend: turns (system, prompt) into a validated definition. */
export interface DefinitionProvider {
  name: ProviderName;
  model: string;
  define(system: string, prompt: string): Promise<ConceptDefinition>;
}

export interface DefineOptions {
  provider: DefinitionProvider;
  /** One line describing the product, e.g. "pallet pooling customer portal". */
  domain: string;
  cachePath: string;
  concurrency?: number;
  /** Source strings to quote as usage examples. */
  source: LocaleStrings;
  onProgress?: (done: number, total: number, term: string) => void;
}

export const DefinitionSchema = z.object({
  ambiguous: z.boolean().describe('True if the term is used with more than one distinct meaning in these strings.'),
  senses: z
    .array(
      z.object({
        label: z.string().describe('Short name for this sense, e.g. "issue (dispatch pallets)".'),
        definition: z.string().describe('One or two plain-language sentences a translator could work from.'),
        exampleKeys: z.array(z.string()).describe('Keys from the examples that use this sense.'),
      }),
    )
    .min(1),
  translatorNote: z.string().describe('What a translator must know to render this term correctly; mention wrong renderings seen.'),
  confidence: z.enum(['low', 'medium', 'high']),
});

/** The definition schema as plain JSON Schema, for providers that take one (Gemini, Claude Code CLI). */
export const DEFINITION_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _unused, ...schema } = z.toJSONSchema(DefinitionSchema) as Record<string, unknown>;
  return schema;
})();

export const SYSTEM = `You help build a concept glossary for software localisation. You are given a term that appears in the UI strings of one product, with example strings (and their i18n keys, which hint at the screen or feature), plus how translators rendered the term in several languages.

Work out what the term means in this product. Keys and surrounding words are the strongest evidence; different renderings across languages often reveal that translators understood the term differently. If the strings use the term in more than one sense, list each sense separately and say which example keys use it. Write definitions for a translator who has never seen the product: concrete, domain-specific, no marketing language. If the evidence is thin, say so and set confidence to low rather than guessing.`;

/** Build the provider; its SDK is only imported when that provider is chosen. */
export async function createProvider(name: ProviderName, model = DEFAULT_DEFINE_MODELS[name]): Promise<DefinitionProvider> {
  if (name === 'gemini') return (await import('./providers/gemini.js')).geminiProvider(model);
  if (name === 'claude-code') return (await import('./providers/claude-code.js')).claudeCodeProvider(model);
  return (await import('./providers/claude.js')).claudeProvider(model);
}

/** Draft concept definitions for the given terms (cached per provider, model and input, so reruns are free). */
export async function defineTerms(terms: TermResult[], opts: DefineOptions): Promise<Map<string, ConceptDefinition>> {
  const { provider } = opts;
  const cache = await loadCache(opts.cachePath);
  const out = new Map<string, ConceptDefinition>();
  let done = 0;

  const queue = [...terms];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const prompt = buildPrompt(t, opts);
      const key = hash(provider.name, provider.model, SYSTEM, prompt);
      let def = cache[key];
      if (!def) {
        try {
          def = await provider.define(SYSTEM, prompt);
        } catch (err) {
          throw new Error(`${provider.name} (${provider.model}) failed on "${t.term}": ${(err as Error).message}`);
        }
        cache[key] = def;
        await saveCache(opts.cachePath, cache);
      }
      out.set(t.term, def);
      opts.onProgress?.(++done, terms.length, t.term);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, terms.length) }, worker));
  return out;
}

export function buildPrompt(t: TermResult, opts: Pick<DefineOptions, 'domain' | 'source'>): string {
  const exampleKeys = new Set<string>();
  const lines: string[] = [];
  lines.push(`Product: ${opts.domain}`);
  lines.push(`Term: "${t.term}" (surface forms: ${Object.keys(t.surfaces).slice(0, 6).join(', ') || 'n/a'})`);
  lines.push(`Appears in ${t.df} distinct source strings.`);
  lines.push('');
  lines.push('Renderings by language (count of distinct strings, example keys):');
  for (const p of t.perLocale.filter((p) => p.occurrences > 0).slice(0, 16)) {
    const parts = p.clusters.slice(0, 4).map((c) => {
      c.exampleKeys.slice(0, 2).forEach((k) => exampleKeys.add(k));
      const label = c.keptEnglish ? `(left in English: ${c.forms[0]!.text})` : c.forms[0]!.text;
      return `${label} x${c.count} [${c.exampleKeys.slice(0, 2).join(', ')}]`;
    });
    lines.push(`- ${p.locale}: ${parts.join('; ')}`);
  }
  lines.push('');
  lines.push('English example strings (key: text):');
  for (const k of [...exampleKeys].slice(0, 24)) {
    const v = opts.source.get(k);
    if (v) lines.push(`- ${k}: ${JSON.stringify(v.length > 200 ? `${v.slice(0, 200)}…` : v)}`);
  }
  return lines.join('\n');
}

type Cache = Record<string, ConceptDefinition>;

async function loadCache(file: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

async function saveCache(file: string, cache: Cache): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache, null, 2));
}

const hash = (...parts: string[]) => createHash('sha1').update(parts.join('\u001f')).digest('hex');
