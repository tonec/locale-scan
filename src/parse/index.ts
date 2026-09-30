import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocaleSet, LocaleStrings } from '../types.js';
import { isLocaleCode, localeFromFilename, normaliseLocaleCode } from './detect.js';
import { flattenJson } from './json.js';

export interface LoadOptions {
  separator?: string;
}

/**
 * Load a locale directory in either layout:
 *   dir/<locale>.json               (one file per locale)
 *   dir/<locale>/<namespace>.json   (keys prefixed with `<namespace>.`)
 */
export async function loadLocaleDir(dir: string, opts: LoadOptions = {}): Promise<LocaleSet> {
  const separator = opts.separator ?? '.';
  const set: LocaleSet = { locales: new Map(), files: new Map(), warnings: [] };
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const locale = localeFromFilename(entry.name);
      if (locale) await addFile(set, locale, full, '', separator);
    } else if (entry.isDirectory() && isLocaleCode(entry.name)) {
      const locale = normaliseLocaleCode(entry.name);
      const nsFiles = (await readdir(full)).filter((f) => f.endsWith('.json')).sort();
      for (const f of nsFiles) {
        await addFile(set, locale, path.join(full, f), path.basename(f, '.json'), separator);
      }
    }
  }

  if (set.locales.size === 0) {
    throw new Error(`No locale files found in ${dir}`);
  }
  return set;
}

async function addFile(set: LocaleSet, locale: string, file: string, prefix: string, separator: string) {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    set.warnings.push({ locale, file, message: `Invalid JSON: ${(err as Error).message}` });
    return;
  }

  let flat;
  try {
    flat = flattenJson(data, separator, prefix);
  } catch (err) {
    set.warnings.push({ locale, file, message: (err as Error).message });
    return;
  }

  const strings: LocaleStrings = set.locales.get(locale) ?? new Map();
  for (const [key, value] of flat.strings) {
    if (strings.has(key)) {
      set.warnings.push({ locale, file, key, message: 'Duplicate key; later value wins' });
    }
    strings.set(key, value);
  }
  for (const s of flat.skipped) {
    set.warnings.push({ locale, file, key: s.key, message: `Skipped non-string value (${s.type})` });
  }
  set.locales.set(locale, strings);
  set.files.set(locale, [...(set.files.get(locale) ?? []), file]);
}
