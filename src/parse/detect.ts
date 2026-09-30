import path from 'node:path';

// en, en-GB, en_GB, zh-Hans-CN, pt-br
const LOCALE_RE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/i;

export function isLocaleCode(name: string): boolean {
  return LOCALE_RE.test(name);
}

/** Canonical form used for comparison: lowercase, hyphen-separated. */
export function normaliseLocaleCode(code: string): string {
  return code.replace(/_/g, '-').toLowerCase();
}

/** `en-gb.json` -> `en-gb`; returns undefined for non-locale names. */
export function localeFromFilename(file: string): string | undefined {
  const base = path.basename(file, path.extname(file));
  return isLocaleCode(base) ? normaliseLocaleCode(base) : undefined;
}
