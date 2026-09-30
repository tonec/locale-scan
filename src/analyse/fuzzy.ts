import type { FuzzyGroup, LocaleStrings, ValueKeys } from '../types.js';
import { normalise } from './normalise.js';

export interface FuzzyOptions {
  /** Minimum similarity (0..1) for two strings to be linked. */
  threshold?: number;
  /** Strings longer than this (normalised) are skipped. */
  maxLength?: number;
  /** Tokens appearing in more strings than this are not used for blocking (unless a string has nothing rarer). */
  maxPostings?: number;
}

/**
 * Near-duplicates that exact/normalised grouping misses, e.g. "Issue date" vs
 * "Issued date" or "Date of issue" vs "Issue date of". Works on distinct
 * normalised forms, so each exact/variant group appears as one node.
 *
 * Avoids all-pairs comparison by blocking: only strings sharing a reasonably
 * rare word (or, for short strings, a char trigram) are compared.
 */
export function findFuzzy(strings: LocaleStrings, opts: FuzzyOptions = {}): FuzzyGroup[] {
  const threshold = opts.threshold ?? 0.85;
  const maxLength = opts.maxLength ?? 200;
  const maxPostings = opts.maxPostings ?? 300;

  // Distinct normalised forms -> raw values -> keys.
  const nodes = new Map<string, Map<string, string[]>>();
  for (const [key, value] of strings) {
    const norm = normalise(value);
    if (norm.length < 3 || norm.length > maxLength) continue;
    let values = nodes.get(norm);
    if (!values) nodes.set(norm, (values = new Map()));
    const keys = values.get(value);
    if (keys) keys.push(key);
    else values.set(value, [key]);
  }
  const texts = [...nodes.keys()];
  const sorted = texts.map((t) => t.split(' ').sort().join(' '));

  // Blocking index: word tokens for everything, char trigrams for 1-2 word strings.
  const features = texts.map(blockingFeatures);
  const postings = new Map<string, number[]>();
  features.forEach((fs, i) => {
    for (const f of fs) {
      const list = postings.get(f);
      if (list) list.push(i);
      else postings.set(f, [i]);
    }
  });

  const uf = new UnionFind(texts.length);
  const linkSim = new Map<number, number>(); // node index -> lowest similarity of an edge touching it

  for (let i = 0; i < texts.length; i++) {
    const a = texts[i]!;
    const candidates = new Set<number>();
    const usable = features[i]!.filter((f) => postings.get(f)!.length <= maxPostings);
    const blockOn = usable.length ? usable : [rarest(features[i]!, postings)];
    for (const f of blockOn) {
      for (const j of postings.get(f)!) if (j > i) candidates.add(j);
    }

    for (const j of candidates) {
      const b = texts[j]!;
      if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < threshold) continue;
      if (differOnlyInNumbers(a, b)) continue;
      const sim = Math.max(similarity(a, b, threshold), similarity(sorted[i]!, sorted[j]!, threshold));
      if (sim >= threshold) {
        uf.union(i, j);
        linkSim.set(i, Math.min(linkSim.get(i) ?? 1, sim));
        linkSim.set(j, Math.min(linkSim.get(j) ?? 1, sim));
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < texts.length; i++) {
    if (!linkSim.has(i)) continue;
    const root = uf.find(i);
    const members = byRoot.get(root);
    if (members) members.push(i);
    else byRoot.set(root, [i]);
  }

  const groups: FuzzyGroup[] = [];
  for (const idxs of byRoot.values()) {
    const members: ValueKeys[] = [];
    for (const i of idxs) {
      for (const [value, keys] of nodes.get(texts[i]!)!) members.push({ value, keys });
    }
    groups.push({
      minSimilarity: round(Math.min(...idxs.map((i) => linkSim.get(i)!))),
      members,
    });
  }
  // Closest matches first: small wording drift ("Reverse" vs "Reversed") is more actionable
  // than long templated lists that differ only in a name.
  return groups.sort((a, b) => b.minSimilarity - a.minSimilarity || a.members.length - b.members.length);
}

function blockingFeatures(text: string): string[] {
  const words = [...new Set(text.split(' ').filter((w) => w.length > 1))];
  if (words.length > 2) return words.map((w) => `w:${w}`);
  const grams = new Set<string>();
  const padded = ` ${text} `;
  for (let k = 0; k + 3 <= padded.length; k++) grams.add(`g:${padded.slice(k, k + 3)}`);
  return [...words.map((w) => `w:${w}`), ...grams];
}

function rarest(features: string[], postings: Map<string, number[]>): string {
  return features.reduce((best, f) => (postings.get(f)!.length < postings.get(best)!.length ? f : best));
}

/** "Level 1" vs "Level 2", "30 days" vs "60 days": different meaning, not a near-duplicate. */
function differOnlyInNumbers(a: string, b: string): boolean {
  return a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#');
}

/** 1 - normalised Levenshtein distance, with early exit once below `min`. */
export function similarity(a: string, b: string, min = 0): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const budget = Math.floor((1 - min) * maxLen);
  const d = levenshtein(a, b, budget);
  return d > budget ? 0 : 1 - d / maxLen;
}

function levenshtein(a: string, b: string, budget: number): number {
  if (Math.abs(a.length - b.length) > budget) return budget + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > budget) return budget + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
