import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { UnusedResult } from '../types.js';

export interface UnusedOptions {
  extensions?: string[];
  /** Keys starting with any of these are assumed to be built dynamically and never reported. */
  dynamicPrefixes?: string[];
  ignoreDirs?: string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.html'];
const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next'];

// '...' "..." `...` (template literals are cut at the first ${ below)
const LITERAL_RE = /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g;

/**
 * Keys that never appear as a string literal in the source tree. Heuristic:
 * keys assembled at runtime can't be seen, so literal prefixes that look like
 * key fragments (`error.${code}` or 'error.' + code) are treated as dynamic.
 */
export async function findUnused(keys: Iterable<string>, srcDir: string, opts: UnusedOptions = {}): Promise<UnusedResult> {
  const extensions = new Set(opts.extensions ?? DEFAULT_EXTENSIONS);
  const ignore = new Set(opts.ignoreDirs ?? DEFAULT_IGNORE);
  const literals = new Set<string>();
  const dynamicPrefixes = new Set(opts.dynamicPrefixes ?? []);

  const files = await walk(srcDir, extensions, ignore);
  for (const file of files) {
    const code = await readFile(file, 'utf8');
    for (const m of code.matchAll(LITERAL_RE)) {
      const raw = m[1] ?? m[2];
      if (raw !== undefined) {
        literals.add(raw);
        if (/^[\w-]+[._]$/.test(raw) || /^[\w-]+(?:\.[\w-]+)+[._]$/.test(raw)) dynamicPrefixes.add(raw);
        continue;
      }
      const tpl = m[3]!;
      const cut = tpl.indexOf('${');
      if (cut === -1) literals.add(tpl);
      else if (cut > 0) dynamicPrefixes.add(tpl.slice(0, cut));
    }
  }

  const prefixes = [...dynamicPrefixes].filter((p) => p.length >= 3);
  const unused: string[] = [];
  let skippedDynamic = 0;
  for (const key of keys) {
    if (literals.has(key)) continue;
    if (prefixes.some((p) => key.startsWith(p))) skippedDynamic++;
    else unused.push(key);
  }
  return { scannedFiles: files.length, unused, skippedDynamic };
}

async function walk(dir: string, extensions: Set<string>, ignore: Set<string>): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignore.has(entry.name)) out.push(...(await walk(full, extensions, ignore)));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}
