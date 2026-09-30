export interface FlattenResult {
  strings: Map<string, string>;
  /** Keys whose leaf value was not a string (arrays, numbers, null...). */
  skipped: { key: string; type: string }[];
}

/**
 * Flatten flat or nested JSON into dotted keys. A flat file whose keys already
 * contain dots comes through unchanged.
 */
export function flattenJson(data: unknown, separator = '.', prefix = ''): FlattenResult {
  const strings = new Map<string, string>();
  const skipped: FlattenResult['skipped'] = [];

  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      strings.set(path, node);
    } else if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}${separator}${k}` : k);
      }
    } else {
      skipped.push({ key: path, type: Array.isArray(node) ? 'array' : node === null ? 'null' : typeof node });
    }
  };

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Locale file root must be a JSON object');
  }
  walk(data, prefix);
  return { strings, skipped };
}
