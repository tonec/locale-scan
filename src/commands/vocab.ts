import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Io } from '../io.js';
import { normaliseLocaleCode } from '../parse/detect.js';
import { loadLocaleDir } from '../parse/index.js';
import { align, DEFAULT_MODEL, DEFAULT_MODEL_FOR, defaultCache, defaultPython, zipf } from '../vocab/aligner.js';
import { measureConsistency } from '../vocab/consistency.js';
import { createProvider, DEFAULT_DEFINE_MODELS, defineTerms, PROVIDERS, type ProviderName } from '../vocab/define.js';
import { estimate, rankForGlossary } from '../vocab/estimate.js';
import { buildRequests, language, planLocales } from '../vocab/pairs.js';
import { renderVocabText } from '../vocab/report.js';
import { extractTerms } from '../vocab/terms.js';
import type { VocabResult } from '../vocab/types.js';

export const VOCAB_USAGE = `Usage: locale-scan vocab <localeDir> [options]

Mines recurring domain terms from the source locale, aligns every translated
string to its source with a multilingual word aligner (aligner/align.py), and
reports how consistently each term was rendered per language.

Options:
  --source <locale>          Source locale (default: en)
  --locales <list>           Only these target locales/languages (comma-separated)
  --min-df <n>               Minimum distinct source strings per term (default: 5)
  --max-n <n>                Longest phrase in words (default: 3)
  --seed <file>              Newline-separated terms to always include
  --model <name>             Aligner model (default: ${DEFAULT_MODEL})
  --model-for <lang=model>   Per-language model (repeatable; default: ${Object.entries(DEFAULT_MODEL_FOR).map(([l, m]) => `${l}=${m}`).join(', ')})
  --python <path>            Aligner Python (default: aligner/.venv/bin/python or $LOCALE_SCAN_PYTHON)
  --cache <file>             Alignment cache (default: ~/.cache/locale-scan/align.sqlite)
  --format <text|json|both>  Output format (default: text); "both" writes JSON to --out
  --out <file>               Write the JSON report to a file
  --top <n>                  Terms listed per section in the text report (default: 20)
  --define                   Draft concept definitions with an LLM for the top glossary candidates
  --provider <name>          LLM for --define (default: claude):
                               claude       Anthropic API (ANTHROPIC_API_KEY)
                               claude-code  local Claude Code CLI, uses your Claude plan
                               gemini       Google Gemini API (GEMINI_API_KEY)
  --define-model <id>        Model for --define (defaults: ${PROVIDERS.map((p) => `${p} ${DEFAULT_DEFINE_MODELS[p]}`).join(', ')})
  --define-top <n>           How many terms to define (default: 40)
  --domain <text>            One-line product description for --define (default: "logistics / pallet pooling customer portal")
  -h, --help                 Show this help
`;

export async function vocabCommand(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        source: { type: 'string', default: 'en' },
        locales: { type: 'string' },
        'min-df': { type: 'string', default: '5' },
        'max-n': { type: 'string', default: '3' },
        seed: { type: 'string' },
        model: { type: 'string', default: DEFAULT_MODEL },
        'model-for': { type: 'string', multiple: true },
        python: { type: 'string' },
        cache: { type: 'string' },
        format: { type: 'string', default: 'text' },
        out: { type: 'string' },
        top: { type: 'string', default: '20' },
        define: { type: 'boolean', default: false },
        'define-top': { type: 'string', default: '40' },
        domain: { type: 'string', default: 'logistics / pallet pooling customer portal' },
        provider: { type: 'string', default: 'claude' },
        'define-model': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${VOCAB_USAGE}`);
    return 2;
  }
  const { values: o, positionals } = parsed;
  if (o.help) {
    io.stdout(VOCAB_USAGE);
    return 0;
  }
  const minDf = Number(o['min-df']);
  const maxN = Number(o['max-n']);
  const top = Number(o.top);
  const defineTop = Number(o['define-top']);
  const errors: string[] = [];
  if (positionals.length !== 1) errors.push('expected exactly one <localeDir>');
  if (!['text', 'json', 'both'].includes(o.format)) errors.push('--format must be text, json or both');
  if (!PROVIDERS.includes(o.provider as ProviderName)) errors.push(`--provider must be one of ${PROVIDERS.join(', ')}`);
  if (o.format === 'both' && !o.out) errors.push('--format both requires --out <file>');
  for (const [name, v] of [['--min-df', minDf], ['--max-n', maxN], ['--top', top], ['--define-top', defineTop]] as const) {
    if (!(Number.isInteger(v) && v >= 1)) errors.push(`${name} must be a positive integer`);
  }
  const modelFor: Record<string, string> = { ...DEFAULT_MODEL_FOR };
  for (const kv of o['model-for'] ?? []) {
    const [lang, model] = kv.split('=');
    if (!lang || !model) errors.push(`--model-for expects lang=model, got "${kv}"`);
    else modelFor[lang] = model;
  }
  if (errors.length) {
    io.stderr(errors.map((e) => `error: ${e}`).join('\n') + '\n');
    return 2;
  }

  const progress = (s: string) => io.stderr(`${s}\n`);
  let result: VocabResult;
  try {
    const source = normaliseLocaleCode(o.source);
    const set = await loadLocaleDir(positionals[0]!);
    const sourceStrings = set.locales.get(source);
    if (!sourceStrings) throw new Error(`Source locale "${source}" not found (have: ${[...set.locales.keys()].join(', ')})`);

    // Fail on a missing API key before the slow alignment step, not after it.
    const provider = o.define ? await createProvider(o.provider as ProviderName, o['define-model']) : undefined;

    const seeds = o.seed ? (await readFile(o.seed, 'utf8')).split(/\r?\n/).filter((l) => l.trim()) : [];
    const terms = extractTerms(sourceStrings, { minDf, maxN, seeds });
    progress(`vocab: ${terms.length} candidate terms`);

    const zipfs = await zipf(terms.map((t) => t.id), o.python ?? defaultPython());
    for (const t of terms) t.zipf = zipfs.get(t.id);

    const only = o.locales?.split(',').map((s) => normaliseLocaleCode(s.trim())).filter(Boolean);
    const plan = planLocales(set, source, only);
    if (!plan.groups.size) throw new Error('No target locales left to analyse');
    const requests = buildRequests(sourceStrings, set, [...plan.groups.keys()], terms);
    progress(`vocab: aligning ${requests.length} string pairs across ${plan.groups.size} locales`);

    const aligned = await align(requests, {
      python: o.python,
      model: o.model,
      modelFor,
      cache: o.cache ?? defaultCache(),
      onProgress: progress,
    });

    const termResults = measureConsistency(terms, requests, aligned, plan.groups, {
      modelForLang: (lang) => modelFor[lang] ?? o.model,
    });

    if (provider) {
      const targets = rankForGlossary(termResults).slice(0, defineTop);
      progress(`vocab: drafting definitions for ${targets.length} terms with ${provider.name} (${provider.model})`);
      const defs = await defineTerms(targets, {
        provider,
        domain: o.domain,
        source: sourceStrings,
        cachePath: path.join(path.dirname(o.cache ?? defaultCache()), 'definitions.json'),
        onProgress: (done, total, term) => progress(`define: ${done}/${total} ${term}`),
      });
      for (const t of termResults) t.definition = defs.get(t.term);
    }

    const models: Record<string, string> = { '*': o.model };
    for (const lang of new Set([...plan.groups.keys()].map(language))) if (modelFor[lang]) models[lang] = modelFor[lang];
    result = {
      source,
      localeGroups: Object.fromEntries(plan.groups),
      skippedLocales: plan.skipped,
      alignment: { pairs: requests.length, models },
      estimate: estimate(termResults),
      terms: termResults.sort((a, b) => b.df - a.df || a.term.localeCompare(b.term)),
    };
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\n`);
    return 2;
  }

  if (o.format === 'text' || o.format === 'both') io.stdout(renderVocabText(result, { top }));
  if (o.format === 'json' || o.format === 'both') {
    const json = JSON.stringify({ reportVersion: 1, generatedAt: new Date().toISOString(), ...result }, null, 2) + '\n';
    if (o.out) {
      await mkdir(path.dirname(path.resolve(o.out)), { recursive: true });
      await writeFile(o.out, json);
      io.stderr(`JSON report written to ${o.out}\n`);
    } else io.stdout(json);
  }
  return 0;
}

