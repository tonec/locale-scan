import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AlignRequest } from './pairs.js';

export interface AlignResult {
  id: number;
  srcWords: string[];
  tgtUnits: string[];
  tgtStems: string[];
  joiner: string;
  links: [number, number][];
  /** Per source word: inclusive target unit range, or null when unaligned. */
  spans: ([number, number] | null)[];
  /** Per source word: cosine similarity of its best link, or null. */
  scores: (number | null)[];
}

export interface AlignerOptions {
  python?: string;
  model?: string;
  /** Per-language model overrides, e.g. { th: 'xlm-roberta-base' }. */
  modelFor?: Record<string, string>;
  cache?: string;
  /** Called with the aligner's progress lines. */
  onProgress?: (line: string) => void;
}

export const DEFAULT_MODEL = 'bert-base-multilingual-cased';
/** mBERT tokenises Thai poorly; XLM-R's SentencePiece vocabulary handles it. */
export const DEFAULT_MODEL_FOR: Record<string, string> = { th: 'xlm-roberta-base' };

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PACKAGE_ROOT, 'aligner', 'align.py');

export function defaultPython(): string {
  return process.env.LOCALE_SCAN_PYTHON ?? path.join(PACKAGE_ROOT, 'aligner', '.venv', 'bin', 'python');
}

export function defaultCache(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache');
  return path.join(base, 'locale-scan', 'align.sqlite');
}

export async function align(requests: AlignRequest[], opts: AlignerOptions = {}): Promise<Map<number, AlignResult>> {
  const args = ['align', '--model', opts.model ?? DEFAULT_MODEL, '--cache', opts.cache ?? defaultCache()];
  for (const [lang, model] of Object.entries(opts.modelFor ?? DEFAULT_MODEL_FOR)) args.push('--model-for', `${lang}=${model}`);
  const lines = requests.map((r) => JSON.stringify({ id: r.id, src: r.src, tgt: r.tgt, lang: r.lang }));

  const results = new Map<number, AlignResult>();
  await runPython(opts.python ?? defaultPython(), args, lines, (line) => {
    const r = JSON.parse(line) as AlignResult;
    results.set(r.id, r);
  }, opts.onProgress);
  return results;
}

/** Zipf frequency of each term in general English (wordfreq). */
export async function zipf(terms: string[], python = defaultPython()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await runPython(python, ['zipf'], terms.map((term) => JSON.stringify({ term })), (line) => {
    const r = JSON.parse(line) as { term: string; zipf: number };
    out.set(r.term, r.zipf);
  });
  return out;
}

function runPython(
  python: string,
  args: string[],
  input: string[],
  onLine: (line: string) => void,
  onProgress?: (line: string) => void,
): Promise<void> {
  if (!existsSync(python)) {
    return Promise.reject(
      new Error(`Aligner Python not found at ${python}. Run "npm run setup:aligner" or set LOCALE_SCAN_PYTHON / --python.`),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TRANSFORMERS_VERBOSITY: 'error',
        HF_HUB_DISABLE_PROGRESS_BARS: '1',
        TOKENIZERS_PARALLELISM: 'false',
        PYTORCH_ENABLE_MPS_FALLBACK: '1',
      },
    });
    const stderrTail: string[] = [];
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      if (line.startsWith('align:')) onProgress?.(line);
    });
    let parseError: Error | undefined;
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim() || parseError) return;
      try {
        onLine(line);
      } catch (err) {
        parseError = err as Error;
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Aligner exited with code ${code}:\n${stderrTail.join('\n')}`));
      else if (parseError) reject(parseError);
      else resolve();
    });
    child.stdin.on('error', () => {}); // surfaced via the exit code instead
    for (const line of input) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}
