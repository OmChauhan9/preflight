#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatCheckReport,
  runCheck,
  type CheckClientMeta,
  type CheckOptions,
  type CheckReport,
} from './check.js';
import { redactSecrets } from './clients/http.js';
import {
  createClientFromEnv,
  type OpenAICompatibleClientOptions,
} from './clients/openai-compatible.js';
import {
  isProviderName,
  PROVIDER_NAMES,
  type EnvSource,
} from './clients/providers.js';
import type { LlmClient } from './clients/types.js';
import { loadEnv } from './env.js';
import {
  formatExplainReport,
  runExplain,
  type ExplainClientMeta,
  type ExplainOptions,
  type ExplainResult,
} from './explain/index.js';
import {
  installPrePushHook,
  type InstallPrePushHookResult,
} from './hooks/index.js';

export type CliCommand = 'check' | 'explain' | 'init' | 'bench';

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export type CreateCliClientFn = (
  options: OpenAICompatibleClientOptions,
) => LlmClient;

export interface CliDependencies {
  cwd?: string;
  env?: EnvSource;
  createClient?: CreateCliClientFn;
  runCheckFn?: (
    options: CheckOptions,
    client: LlmClient,
    clientMeta: CheckClientMeta,
  ) => Promise<CheckReport>;
  runExplainFn?: (
    options: ExplainOptions,
    client: LlmClient,
    clientMeta: ExplainClientMeta,
  ) => Promise<ExplainResult>;
  installHookFn?: typeof installPrePushHook;
  readFileFn?: (filePath: string) => string;
}

const VALID_COMMANDS: ReadonlySet<string> = new Set<CliCommand>([
  'check',
  'explain',
  'init',
  'bench',
]);

const ENV_SECRET_KEYS: readonly string[] = [
  'PREFLIGHT_API_KEY',
  'OLLAMA_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'CEREBRAS_API_KEY',
];

const USAGE = [
  'Preflight — fast, verifiable CI pre-checks for AI coding agents',
  '',
  'Usage: preflight <command> [options]',
  '',
  'Commands:',
  '  check                  Run scoped CI pre-checks on current changes',
  '  explain <log>          Explain a CI failure log (local file or GitHub Actions URL)',
  '  init --hook            Install optional git pre-push hook',
  '  bench                  Run benchmark suite (not implemented)',
  '',
  'Options:',
  '  --provider <ollama|groq|gemini|openrouter|openai|cerebras|custom>',
  '                         LLM provider preset (default: ollama)',
  '  --model <name>         Override the provider model name',
  '  --base <ref>           Git base ref to diff against (default: auto-detect)',
  '  --log <file>           Attach a recent CI failure log to check context',
  '  --timeout <seconds>    Per-command verification timeout in seconds (default: 60)',
  '  --no-verify            Skip local reproduction check during explain',
  '  --hook                 Install the git pre-push hook (used with init)',
  '  --force                Overwrite an existing custom pre-push hook (used with init)',
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

interface ParsedCliArgs {
  command?: string;
  positionals: string[];
  showHelp: boolean;
  provider?: string;
  model?: string;
  baseRef?: string;
  logFile?: string;
  timeoutMs?: number;
  json: boolean;
  think: boolean;
  noVerify: boolean;
  hook: boolean;
  force: boolean;
}

function validateProviderFlag(value: string, io: CliIo): boolean {
  if (!isProviderName(value.toLowerCase())) {
    io.stderr(
      `Unknown provider: ${value}. Supported providers: ${PROVIDER_NAMES.join(', ')}`,
    );
    return false;
  }
  return true;
}

function parseTimeoutMs(rawValue: string, io: CliIo): number | null {
  const trimmed = rawValue.trim();
  const seconds = Number(trimmed);
  if (trimmed.length === 0 || !Number.isFinite(seconds) || seconds <= 0) {
    io.stderr(
      `Invalid value for --timeout: "${rawValue}". Expected a positive number of seconds.`,
    );
    return null;
  }
  return Math.max(1, Math.round(seconds * 1000));
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flagName: string,
  io: CliIo,
  allowNegativeNumber = false,
): { ok: true; value: string; nextIndex: number } | { ok: false } {
  const token = argv[index] ?? '';
  if (token === flagName) {
    const value = argv[index + 1];
    const looksLikeOption =
      value !== undefined &&
      value.startsWith('-') &&
      !(allowNegativeNumber && /^-\d/.test(value));
    if (!value || looksLikeOption) {
      io.stderr(`Missing value for ${flagName}`);
      return { ok: false };
    }
    return { ok: true, value, nextIndex: index + 1 };
  }

  const prefix = `${flagName}=`;
  if (token.startsWith(prefix)) {
    const value = token.slice(prefix.length);
    if (value.length === 0) {
      io.stderr(`Missing value for ${flagName}`);
      return { ok: false };
    }
    return { ok: true, value, nextIndex: index };
  }

  return { ok: false };
}

function parseCliArgs(
  argv: readonly string[],
  io: CliIo,
): ParsedCliArgs | null {
  const parsed: ParsedCliArgs = {
    positionals: [],
    showHelp: false,
    json: false,
    think: false,
    noVerify: false,
    hook: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }

    if (token === '--help' || token === '-h') {
      parsed.showHelp = true;
      continue;
    }

    if (token === '--json') {
      parsed.json = true;
      continue;
    }

    if (token === '--think') {
      parsed.think = true;
      continue;
    }

    if (token === '--no-verify') {
      parsed.noVerify = true;
      continue;
    }

    if (token === '--hook') {
      parsed.hook = true;
      continue;
    }

    if (token === '--force') {
      parsed.force = true;
      continue;
    }

    if (token === '--provider' || token.startsWith('--provider=')) {
      const read = readFlagValue(argv, i, '--provider', io);
      if (!read.ok) {
        return null;
      }
      if (!validateProviderFlag(read.value, io)) {
        return null;
      }
      parsed.provider = read.value.toLowerCase();
      i = read.nextIndex;
      continue;
    }

    if (token === '--model' || token.startsWith('--model=')) {
      const read = readFlagValue(argv, i, '--model', io);
      if (!read.ok) {
        return null;
      }
      parsed.model = read.value;
      i = read.nextIndex;
      continue;
    }

    if (token === '--base' || token.startsWith('--base=')) {
      const read = readFlagValue(argv, i, '--base', io);
      if (!read.ok) {
        return null;
      }
      parsed.baseRef = read.value;
      i = read.nextIndex;
      continue;
    }

    if (token === '--log' || token.startsWith('--log=')) {
      const read = readFlagValue(argv, i, '--log', io);
      if (!read.ok) {
        return null;
      }
      parsed.logFile = read.value;
      i = read.nextIndex;
      continue;
    }

    if (token === '--timeout' || token.startsWith('--timeout=')) {
      const read = readFlagValue(argv, i, '--timeout', io, true);
      if (!read.ok) {
        return null;
      }
      const timeoutMs = parseTimeoutMs(read.value, io);
      if (timeoutMs === null) {
        return null;
      }
      parsed.timeoutMs = timeoutMs;
      i = read.nextIndex;
      continue;
    }

    if (token.startsWith('-')) {
      io.stderr(`Unknown option: ${token}`);
      return null;
    }

    if (parsed.command === undefined) {
      parsed.command = token;
    } else {
      parsed.positionals.push(token);
    }
  }

  return parsed;
}

function collectEnvSecrets(env: EnvSource): string[] {
  const secrets: string[] = [];
  for (const key of ENV_SECRET_KEYS) {
    const value = env[key]?.trim();
    if (value && value.length > 0) {
      secrets.push(value);
    }
  }
  return secrets;
}

function buildClientOptions(
  parsed: ParsedCliArgs,
  env: EnvSource,
): OpenAICompatibleClientOptions {
  const options: OpenAICompatibleClientOptions = { env };
  if (parsed.provider !== undefined) {
    options.provider = parsed.provider;
  }
  if (parsed.model !== undefined) {
    options.model = parsed.model;
  }
  return options;
}

function formatHookInstallResult(result: InstallPrePushHookResult): string {
  const headline =
    result.status === 'installed'
      ? `Installed Preflight pre-push hook at ${result.hookPath}`
      : result.status === 'updated'
        ? `Updated Preflight pre-push hook at ${result.hookPath}`
        : `Preflight pre-push hook is already installed at ${result.hookPath}`;
  return `${headline}\nBypass anytime with: git push --no-verify`;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  deps: CliDependencies = {},
): Promise<number> {
  const parsed = parseCliArgs(argv, io);
  if (parsed === null) {
    return 1;
  }

  if (parsed.showHelp || parsed.command === undefined) {
    io.stdout(USAGE);
    return 0;
  }

  if (!VALID_COMMANDS.has(parsed.command)) {
    io.stderr(
      `Unknown command: ${parsed.command}\nRun "preflight --help" for usage.`,
    );
    return 1;
  }

  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const createClient = deps.createClient ?? createClientFromEnv;
  const runCheckFn = deps.runCheckFn ?? runCheck;
  const runExplainFn = deps.runExplainFn ?? runExplain;
  const installHookFn = deps.installHookFn ?? installPrePushHook;
  const readFileFn =
    deps.readFileFn ?? ((filePath: string) => readFileSync(filePath, 'utf8'));

  try {
    switch (parsed.command as CliCommand) {
      case 'check': {
        let recentCiLog: string | undefined;
        if (parsed.logFile !== undefined) {
          const resolvedLogPath = path.resolve(cwd, parsed.logFile);
          recentCiLog = readFileFn(resolvedLogPath);
        }

        const client = createClient(buildClientOptions(parsed, env));
        const clientMeta: CheckClientMeta = {
          provider: client.provider,
          model: client.model,
          baseUrl: client.baseUrl,
        };

        const checkOptions: CheckOptions = {
          cwd,
          think: parsed.think,
        };
        if (parsed.baseRef !== undefined) {
          checkOptions.baseRef = parsed.baseRef;
        }
        if (recentCiLog !== undefined) {
          checkOptions.recentCiLog = recentCiLog;
        }
        if (parsed.timeoutMs !== undefined) {
          checkOptions.timeoutMs = parsed.timeoutMs;
        }

        const report = await runCheckFn(checkOptions, client, clientMeta);
        if (parsed.json) {
          io.stdout(JSON.stringify(report, null, 2));
        } else {
          io.stdout(formatCheckReport(report));
        }
        return report.verdict === 'failed' ? 1 : 0;
      }

      case 'explain': {
        const source = parsed.positionals[0];
        if (!source) {
          io.stderr(
            'Missing required <log-url-or-file> argument for "explain".\nRun "preflight --help" for usage.',
          );
          return 1;
        }

        const client = createClient(buildClientOptions(parsed, env));
        const clientMeta: ExplainClientMeta = {
          provider: client.provider,
          model: client.model,
          baseUrl: client.baseUrl,
        };

        const explainOptions: ExplainOptions = {
          source,
          cwd,
          think: parsed.think,
          verify: !parsed.noVerify,
        };
        if (parsed.baseRef !== undefined) {
          explainOptions.baseRef = parsed.baseRef;
        }
        if (parsed.timeoutMs !== undefined) {
          explainOptions.timeoutMs = parsed.timeoutMs;
        }

        const result = await runExplainFn(explainOptions, client, clientMeta);
        if (parsed.json) {
          io.stdout(JSON.stringify(result, null, 2));
        } else {
          io.stdout(formatExplainReport(result));
        }
        return 0;
      }

      case 'init': {
        const result = installHookFn(cwd, { force: parsed.force });
        if (parsed.json) {
          io.stdout(JSON.stringify(result, null, 2));
        } else {
          io.stdout(formatHookInstallResult(result));
        }
        return 0;
      }

      case 'bench': {
        io.stdout('not implemented');
        return 0;
      }
    }
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = redactSecrets(rawMessage, collectEnvSecrets(env));
    io.stderr(`Error: ${safeMessage}`);
    return 1;
  }
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
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
