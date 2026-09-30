import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scan } from '../analyse/index.js';
import { loadLocaleDir } from '../parse/index.js';
import { normaliseLocaleCode } from '../parse/detect.js';
import { renderJson } from '../report/json.js';
import { renderText } from '../report/text.js';
import type { Io } from '../io.js';
import type { ScanResult } from '../types.js';

export const SCAN_USAGE = `Usage: locale-scan [scan] <localeDir> [options]

Scans a directory of JSON locale files (<locale>.json, or <locale>/<namespace>.json;
flat or nested) for duplicate, variant, missing and unused strings.

Options:
  --source <locale>          Source locale (default: en)
  --format <text|json|both>  Output format (default: text). "both" prints text and writes JSON to --out
  --out <file>               Write the JSON report to a file instead of stdout
  --src <dir>                Source code directory to check for unused keys
  --dynamic-prefix <prefix>  Key prefix built at runtime; never reported as unused (repeatable)
  --fuzzy-threshold <0..1>   Similarity needed for fuzzy near-duplicates (default: 0.85)
  --fuzzy-max-len <n>        Skip strings longer than this in fuzzy matching (default: 200)
  --no-fuzzy                 Disable fuzzy near-duplicate detection
  --allow-identical <file>   Newline-separated source strings allowed to stay untranslated
  --separator <char>         Separator used to flatten nested keys (default: ".")
  --top <n>                  Groups listed per section in the text report (default: 10)
  --fail-on <list>           Exit 1 if any found: missing,untranslated,duplicates,variants,fuzzy,unused
  -h, --help                 Show this help
`;

const FAIL_CHECKS = ['missing', 'untranslated', 'duplicates', 'variants', 'fuzzy', 'unused'] as const;
type FailCheck = (typeof FAIL_CHECKS)[number];

/** Returns the process exit code: 0 ok, 1 --fail-on triggered, 2 usage/input error. */
export async function scanCommand(argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        source: { type: 'string', default: 'en' },
        format: { type: 'string', default: 'text' },
        out: { type: 'string' },
        src: { type: 'string' },
        'dynamic-prefix': { type: 'string', multiple: true },
        'fuzzy-threshold': { type: 'string', default: '0.85' },
        'fuzzy-max-len': { type: 'string', default: '200' },
        'no-fuzzy': { type: 'boolean', default: false },
        'allow-identical': { type: 'string' },
        separator: { type: 'string', default: '.' },
        top: { type: 'string', default: '10' },
        'fail-on': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${SCAN_USAGE}`);
    return 2;
  }
  const { values: o, positionals } = args;

  if (o.help) {
    io.stdout(SCAN_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    io.stderr(SCAN_USAGE);
    return 2;
  }

  const format = o.format;
  const threshold = Number(o['fuzzy-threshold']);
  const maxLength = Number(o['fuzzy-max-len']);
  const top = Number(o.top);
  const failOn = (o['fail-on'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const errors: string[] = [];
  if (!['text', 'json', 'both'].includes(format)) errors.push(`--format must be text, json or both`);
  if (format === 'both' && !o.out) errors.push('--format both requires --out <file>');
  if (!(threshold > 0 && threshold <= 1)) errors.push('--fuzzy-threshold must be in (0, 1]');
  if (!(maxLength > 0)) errors.push('--fuzzy-max-len must be a positive number');
  if (!(Number.isInteger(top) && top >= 0)) errors.push('--top must be a non-negative integer');
  const badChecks = failOn.filter((c) => !FAIL_CHECKS.includes(c as FailCheck));
  if (badChecks.length) errors.push(`--fail-on: unknown check(s) ${badChecks.join(', ')}`);
  if (errors.length) {
    io.stderr(errors.map((e) => `error: ${e}`).join('\n') + '\n');
    return 2;
  }

  let result: ScanResult;
  try {
    const allowIdentical = o['allow-identical']
      ? new Set((await readFile(o['allow-identical'], 'utf8')).split(/\r?\n/).filter((l) => l.trim()))
      : undefined;
    const set = await loadLocaleDir(positionals[0]!, { separator: o.separator });
    result = await scan(set, {
      source: normaliseLocaleCode(o.source),
      fuzzy: o['no-fuzzy'] ? false : { threshold, maxLength },
      allowIdentical,
      srcDir: o.src,
      unused: { dynamicPrefixes: o['dynamic-prefix'] },
    });
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\n`);
    return 2;
  }

  if (format === 'text' || format === 'both') {
    io.stdout(renderText(result, { top, fuzzyThreshold: threshold, fuzzyEnabled: !o['no-fuzzy'] }));
  }
  if (format === 'json' || format === 'both') {
    const json = renderJson(result);
    if (o.out) {
      await mkdir(path.dirname(path.resolve(o.out)), { recursive: true });
      await writeFile(o.out, json);
      io.stderr(`JSON report written to ${o.out}\n`);
    } else {
      io.stdout(json);
    }
  }

  const failed = failOn.filter((c) => checkFails(c as FailCheck, result));
  if (failed.length) {
    io.stderr(`fail-on: ${failed.join(', ')}\n`);
    return 1;
  }
  return 0;
}

function checkFails(check: FailCheck, r: ScanResult): boolean {
  switch (check) {
    case 'missing':
      return r.missing.some((m) => m.absent.length || m.empty.length);
    case 'untranslated':
      return r.missing.some((m) => m.likelyUntranslated.length);
    case 'duplicates':
      return r.summary.duplicateGroups > 0;
    case 'variants':
      return r.summary.variantGroups > 0;
    case 'fuzzy':
      return r.summary.fuzzyGroups > 0;
    case 'unused':
      return (r.unused?.unused.length ?? 0) > 0;
  }
}
