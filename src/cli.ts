import { scanCommand, SCAN_USAGE } from './commands/scan.js';
import { vocabCommand, VOCAB_USAGE } from './commands/vocab.js';
import { defaultIo, type Io } from './io.js';

export type { Io } from './io.js';

const USAGE = `Usage: locale-scan <command> [options]

Commands:
  scan <localeDir>    Duplicate / variant / missing / unused string report (default)
  vocab <localeDir>   Mine domain terms and measure how consistently they were translated

Run "locale-scan <command> --help" for command options.

${SCAN_USAGE}`;

/** Returns the process exit code. A bare `locale-scan <dir>` runs `scan`. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [first, ...rest] = argv;
  if (first === 'scan') return scanCommand(rest, io);
  if (first === 'vocab') return vocabCommand(rest, io);
  if (first === '--help' || first === '-h' || first === 'help') {
    io.stdout(rest[0] === 'vocab' ? VOCAB_USAGE : USAGE);
    return 0;
  }
  return scanCommand(argv, io);
}
