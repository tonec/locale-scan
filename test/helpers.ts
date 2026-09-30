import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixture = (...parts: string[]) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', ...parts);

export const strings = (obj: Record<string, string>) => new Map(Object.entries(obj));
