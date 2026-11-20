#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';

export type CliCommand = 'check' | 'explain' | 'bench';

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const VALID_COMMANDS: ReadonlySet<string> = new Set<CliCommand>([
  'check',
  'explain',
  'bench',
]);

const USAGE = [
  'Usage: preflight <command> [options]',
  '',
  'Commands:',
  '  check                  Run CI pre-checks (Phase 0 stub)',
  '  explain [log]          Explain a CI failure log (Phase 0 stub)',
  '  bench                  Run benchmark suite (Phase 0 stub)',
  '',
  'Options:',
  '  --provider <name>      LLM provider (e.g. cerebras, moonshot)',
  '  --json                 Emit machine-readable JSON output',
  '  --think                Enable model reasoning mode',
  '  -h, --help             Show this help message',
].join('\n');

const defaultIo: CliIo = {
  stdout: (line: string) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line: string) => {
    process.stderr.write(`${line}\n`);
  },
};

export function runCli(argv: readonly string[], io: CliIo = defaultIo): number {
  let command: string | undefined;
  let showHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }

    if (token === '--help' || token === '-h') {
      showHelp = true;
      continue;
    }

    if (token === '--json' || token === '--think') {
      continue;
    }

    if (token === '--provider') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        io.stderr('Missing value for --provider');
        return 1;
      }
      i += 1;
      continue;
    }

    if (token.startsWith('--provider=')) {
      const value = token.slice('--provider='.length);
      if (value.length === 0) {
        io.stderr('Missing value for --provider');
        return 1;
      }
      continue;
    }

    if (token.startsWith('-')) {
      io.stderr(`Unknown option: ${token}`);
      return 1;
    }

    if (command === undefined) {
      command = token;
    }
  }

  if (showHelp || command === undefined) {
    io.stdout(USAGE);
    return 0;
  }

  if (!VALID_COMMANDS.has(command)) {
    io.stderr(`Unknown command: ${command}\nRun "preflight --help" for usage.`);
    return 1;
  }

  io.stdout('not implemented');
  return 0;
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    const currentFile = realpathSync(fileURLToPath(import.meta.url));
    const invokedFile = realpathSync(entryArg);
    return currentFile === invokedFile;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  loadEnv();
  const exitCode = runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
