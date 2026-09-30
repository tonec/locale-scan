import type { ScanResult } from '../types.js';

export const REPORT_VERSION = 1;

export function renderJson(r: ScanResult): string {
  return JSON.stringify({ reportVersion: REPORT_VERSION, generatedAt: new Date().toISOString(), ...r }, null, 2) + '\n';
}
