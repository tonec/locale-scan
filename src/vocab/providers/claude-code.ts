import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { DEFINITION_JSON_SCHEMA, DefinitionSchema, type DefinitionProvider } from '../define.js';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Runs the CLI with args and stdin; injectable so tests don't spawn `claude`. */
export type Runner = (args: string[], stdin: string) => Promise<RunResult>;

/** Fields of `claude -p --output-format json` this provider reads. */
interface PrintResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  modelUsage?: Record<string, unknown>;
}

const TIMEOUT_MS = 5 * 60_000;

/**
 * Claude through the locally installed Claude Code CLI in print mode, so runs are
 * covered by the user's Claude plan instead of API credits. Tools, MCP servers and
 * session history are off: each term is one self-contained structured-output call.
 */
export async function claudeCodeProvider(model: string, run: Runner = spawnClaude): Promise<DefinitionProvider> {
  // Fail fast (before alignment) if the CLI isn't installed.
  const version = await run(['--version'], '').catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));
  if (version.code !== 0) {
    throw new Error(`Claude Code CLI not available (${version.stderr.trim() || `exit ${version.code}`}). Install it or set LOCALE_SCAN_CLAUDE_BIN.`);
  }

  return {
    name: 'claude-code',
    model,
    async define(system, prompt) {
      const args = [
        '-p',
        '--output-format', 'json',
        '--model', model,
        '--system-prompt', system,
        '--json-schema', JSON.stringify(DEFINITION_JSON_SCHEMA),
        '--tools', '',
        '--strict-mcp-config',
        '--no-session-persistence',
      ];
      const { code, stdout, stderr } = await run(args, prompt);

      let out: PrintResult;
      try {
        out = JSON.parse(stdout) as PrintResult;
      } catch {
        throw new Error(`claude exited with ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
      }
      if (out.is_error || out.subtype !== 'success') {
        const status = out.api_error_status ? ` (API status ${out.api_error_status})` : '';
        throw new Error(`claude returned ${out.subtype ?? 'an error'}${status}: ${(out.result ?? '').slice(0, 300)}`);
      }
      const parsed = DefinitionSchema.safeParse(out.structured_output);
      if (!parsed.success) throw new Error(`claude output did not match the schema: ${parsed.error.message}`);
      // modelUsage is keyed by the resolved model id (e.g. "opus" -> "claude-opus-5-5").
      const resolved = Object.keys(out.modelUsage ?? {})[0] ?? model;
      return { ...parsed.data, model: resolved };
    },
  };
}

function spawnClaude(args: string[], stdin: string): Promise<RunResult> {
  const bin = process.env.LOCALE_SCAN_CLAUDE_BIN ?? 'claude';
  return new Promise((resolve, reject) => {
    // Run outside the project so no CLAUDE.md or project settings leak into the prompt.
    const child = spawn(bin, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // surfaced through the exit code
    child.stdin.end(stdin);
  });
}
