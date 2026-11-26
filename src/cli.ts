#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatBenchReport,
  runBench,
  type BenchClientMeta,
  type BenchOptions,
  type BenchReport,
  type BenchStatusFilter,
} from './bench/index.js';
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
import { loadEnv, type LoadEnvOptions } from './env.js';
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

export const DEFAULT_CLI_LLM_TIMEOUT_MS = 120_000;

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
  loadEnvFn?: (envFilePath?: string, options?: LoadEnvOptions) => void;
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
  runBenchFn?: (
    options: BenchOptions,
    client: LlmClient,
    clientMeta: BenchClientMeta,
  ) => Promise<BenchReport>;
  installHookFn?: typeof installPrePushHook;
  readFileFn?: (filePath: string) => string;
}

const VALID_COMMANDS: ReadonlySet<string> = new Set<CliCommand>([
  'check',
  'explain',
  'init',
  'bench',
]);

const ALLOWED_FLAGS_BY_COMMAND: Readonly<
  Record<CliCommand, ReadonlySet<string>>
> = {
  check: new Set([
    '--json',
    '--env-file',
    '--provider',
    '--model',
    '--think',
    '--base',
    '--log',
    '--timeout',
  ]),
  explain: new Set([
    '--json',
    '--env-file',
    '--provider',
    '--model',
    '--think',
    '--base',
    '--timeout',
    '--no-verify',
  ]),
  init: new Set(['--json', '--env-file', '--hook', '--force']),
  bench: new Set([
    '--json',
    '--env-file',
    '--provider',
    '--model',
    '--think',
    '--cases-dir',
    '--case',
    '--status',
    '--language',
    '--limit',
    '--delay',
    '--out',
  ]),
};

const VALID_BENCH_STATUSES: readonly BenchStatusFilter[] = [
  'fail',
  'pass',
  'all',
];

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
  '  bench                  Run curated benchmark suite and emit metrics',
  '',
  'Options:',
  '  --provider <ollama|groq|gemini|openrouter|openai|cerebras|custom>',
  '                         LLM provider preset (default: ollama)',
  '  --model <name>         Override the provider model name',
  '  --env-file <path>      Load environment variables from a specific .env file',
  '  --base <ref>           Git base ref to diff against (default: auto-detect)',
  '  --log <file>           Attach a recent CI failure log to check context',
  '  --timeout <seconds>    Per-command verification timeout in seconds (default: 60)',
  '  --no-verify            Skip local reproduction check during explain',
  '  --hook                 Install the git pre-push hook (used with init)',
  '  --force                Overwrite an existing custom pre-push hook (used with init)',
  '  --cases-dir <dir>      Benchmark cases directory (default: bench/cases)',
  '  --case <id>            Run a single benchmark case by ID',
  '  --status <fail|pass|all>',
  '                         Filter benchmark cases by status (default: all)',
  '  --language <lang>      Filter benchmark cases by language',
  '  --limit <n>            Limit the number of benchmark cases to run',
  '  --delay <ms>           Delay in milliseconds between benchmark cases (default: 0)',
  '  --out <dir>            Write benchmark summary.md and results.json to directory',
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
  envFile?: string;
  baseRef?: string;
  logFile?: string;
  timeoutMs?: number;
  casesDir?: string;
  caseId?: string;
  status?: BenchStatusFilter;
  language?: string;
  limit?: number;
  delayMs?: number;
  outDir?: string;
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

function parseBenchStatus(
  rawValue: string,
  io: CliIo,
): BenchStatusFilter | null {
  const normalized = rawValue.trim().toLowerCase();
  if (
    normalized === 'fail' ||
    normalized === 'pass' ||
    normalized === 'all'
  ) {
    return normalized;
  }
  io.stderr(
    `Invalid value for --status: "${rawValue}". Expected one of: ${VALID_BENCH_STATUSES.join(', ')}.`,
  );
  return null;
}

function parsePositiveInt(
  rawValue: string,
  flagName: string,
  io: CliIo,
): number | null {
  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    io.stderr(
      `Invalid value for ${flagName}: "${rawValue}". Expected a positive integer.`,
    );
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    io.stderr(
      `Invalid value for ${flagName}: "${rawValue}". Expected a positive integer.`,
    );
    return null;
  }
  return parsed;
}

function parseNonNegativeInt(
  rawValue: string,
  flagName: string,
  io: CliIo,
): number | null {
  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    io.stderr(
      `Invalid value for ${flagName}: "${rawValue}". Expected a non-negative integer.`,
    );
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    io.stderr(
      `Invalid value for ${flagName}: "${rawValue}". Expected a non-negative integer.`,
    );
    return null;
  }
  return parsed;
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

    if (token === '--env-file' || token.startsWith('--env-file=')) {
      const read = readFlagValue(argv, i, '--env-file', io);
      if (!read.ok) {
        return null;
      }
      const trimmedEnvFile = read.value.trim();
      if (trimmedEnvFile.length === 0) {
        io.stderr('Missing value for --env-file');
        return null;
      }
      parsed.envFile = trimmedEnvFile;
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

    if (token === '--cases-dir' || token.startsWith('--cases-dir=')) {
      const read = readFlagValue(argv, i, '--cases-dir', io);
      if (!read.ok) {
        return null;
      }
      parsed.casesDir = read.value;
      i = read.nextIndex;
      continue;
    }

    if (token === '--case' || token.startsWith('--case=')) {
      const read = readFlagValue(argv, i, '--case', io);
      if (!read.ok) {
        return null;
      }
      parsed.caseId = read.value;
      i = read.nextIndex;
      continue;
    }

    if (token === '--status' || token.startsWith('--status=')) {
      const read = readFlagValue(argv, i, '--status', io);
      if (!read.ok) {
        return null;
      }
      const status = parseBenchStatus(read.value, io);
      if (status === null) {
        return null;
      }
      parsed.status = status;
      i = read.nextIndex;
      continue;
    }

    if (token === '--language' || token.startsWith('--language=')) {
      const read = readFlagValue(argv, i, '--language', io);
      if (!read.ok) {
        return null;
      }
      parsed.language = read.value;
      i = read.nextIndex;
      continue;
    }

    if (token === '--limit' || token.startsWith('--limit=')) {
      const read = readFlagValue(argv, i, '--limit', io, true);
      if (!read.ok) {
        return null;
      }
      const limit = parsePositiveInt(read.value, '--limit', io);
      if (limit === null) {
        return null;
      }
      parsed.limit = limit;
      i = read.nextIndex;
      continue;
    }

    if (token === '--delay' || token.startsWith('--delay=')) {
      const read = readFlagValue(argv, i, '--delay', io, true);
      if (!read.ok) {
        return null;
      }
      const delayMs = parseNonNegativeInt(read.value, '--delay', io);
      if (delayMs === null) {
        return null;
      }
      parsed.delayMs = delayMs;
      i = read.nextIndex;
      continue;
    }

    if (token === '--out' || token.startsWith('--out=')) {
      const read = readFlagValue(argv, i, '--out', io);
      if (!read.ok) {
        return null;
      }
      parsed.outDir = read.value;
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

function collectProvidedFlags(parsed: ParsedCliArgs): string[] {
  const flags: string[] = [];
  if (parsed.json) {
    flags.push('--json');
  }
  if (parsed.envFile !== undefined) {
    flags.push('--env-file');
  }
  if (parsed.provider !== undefined) {
    flags.push('--provider');
  }
  if (parsed.model !== undefined) {
    flags.push('--model');
  }
  if (parsed.think) {
    flags.push('--think');
  }
  if (parsed.baseRef !== undefined) {
    flags.push('--base');
  }
  if (parsed.logFile !== undefined) {
    flags.push('--log');
  }
  if (parsed.timeoutMs !== undefined) {
    flags.push('--timeout');
  }
  if (parsed.noVerify) {
    flags.push('--no-verify');
  }
  if (parsed.hook) {
    flags.push('--hook');
  }
  if (parsed.force) {
    flags.push('--force');
  }
  if (parsed.casesDir !== undefined) {
    flags.push('--cases-dir');
  }
  if (parsed.caseId !== undefined) {
    flags.push('--case');
  }
  if (parsed.status !== undefined) {
    flags.push('--status');
  }
  if (parsed.language !== undefined) {
    flags.push('--language');
  }
  if (parsed.limit !== undefined) {
    flags.push('--limit');
  }
  if (parsed.delayMs !== undefined) {
    flags.push('--delay');
  }
  if (parsed.outDir !== undefined) {
    flags.push('--out');
  }
  return flags;
}

function validateCommandFlags(
  command: CliCommand,
  parsed: ParsedCliArgs,
  io: CliIo,
): boolean {
  const allowed = ALLOWED_FLAGS_BY_COMMAND[command];
  const incompatible = collectProvidedFlags(parsed).filter(
    (flag) => !allowed.has(flag),
  );
  if (incompatible.length === 0) {
    return true;
  }
  const label = incompatible.length === 1 ? 'Option' : 'Options';
  io.stderr(
    `${label} ${incompatible.join(', ')} not supported for "${command}".\nRun "preflight --help" for usage.`,
  );
  return false;
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

function createDefaultClient(
  options: OpenAICompatibleClientOptions,
): LlmClient {
  return createClientFromEnv({
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_CLI_LLM_TIMEOUT_MS,
  });
}

function buildClientOptions(
  parsed: ParsedCliArgs,
  env: EnvSource,
): OpenAICompatibleClientOptions {
  const options: OpenAICompatibleClientOptions = {
    env,
    timeoutMs: DEFAULT_CLI_LLM_TIMEOUT_MS,
  };
  if (parsed.provider !== undefined) {
    options.provider = parsed.provider;
  }
  if (parsed.model !== undefined) {
    options.model = parsed.model;
  }
  return options;
}

function stringifyRedactedJson(
  value: unknown,
  secrets: readonly string[],
): string {
  return JSON.stringify(
    value,
    (_key, val: unknown) =>
      typeof val === 'string' ? redactSecrets(val, secrets) : val,
    2,
  );
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

  const command = parsed.command as CliCommand;
  if (!validateCommandFlags(command, parsed, io)) {
    return 1;
  }

  const cwd = deps.cwd ?? process.cwd();
  const baseEnv = deps.env ?? process.env;
  let envSecrets = collectEnvSecrets(baseEnv);
  const loadEnvFn = deps.loadEnvFn ?? loadEnv;
  const createClient = deps.createClient ?? createDefaultClient;
  const runCheckFn = deps.runCheckFn ?? runCheck;
  const runExplainFn = deps.runExplainFn ?? runExplain;
  const runBenchFn = deps.runBenchFn ?? runBench;
  const installHookFn = deps.installHookFn ?? installPrePushHook;
  const readFileFn =
    deps.readFileFn ?? ((filePath: string) => readFileSync(filePath, 'utf8'));

  try {
    let effectiveEnv: EnvSource = baseEnv;
    if (parsed.envFile !== undefined) {
      const mergedEnv: Record<string, string | undefined> = { ...baseEnv };
      const resolvedEnvPath = path.resolve(cwd, parsed.envFile);
      loadEnvFn(resolvedEnvPath, { targetEnv: mergedEnv });
      effectiveEnv = mergedEnv;
      envSecrets = collectEnvSecrets(effectiveEnv);
    }

    switch (command) {
      case 'check': {
        let recentCiLog: string | undefined;
        if (parsed.logFile !== undefined) {
          const resolvedLogPath = path.resolve(cwd, parsed.logFile);
          recentCiLog = readFileFn(resolvedLogPath);
        }

        const client = createClient(buildClientOptions(parsed, effectiveEnv));
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
          io.stdout(stringifyRedactedJson(report, envSecrets));
        } else {
          io.stdout(redactSecrets(formatCheckReport(report), envSecrets));
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

        const client = createClient(buildClientOptions(parsed, effectiveEnv));
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
          io.stdout(stringifyRedactedJson(result, envSecrets));
        } else {
          io.stdout(redactSecrets(formatExplainReport(result), envSecrets));
        }
        return 0;
      }

      case 'init': {
        if (!parsed.hook) {
          io.stderr(
            'Missing required --hook flag for "init". Run "preflight init --hook" to install the git pre-push hook.',
          );
          return 1;
        }

        const result = installHookFn(cwd, { force: parsed.force });
        if (parsed.json) {
          io.stdout(stringifyRedactedJson(result, envSecrets));
        } else {
          io.stdout(redactSecrets(formatHookInstallResult(result), envSecrets));
        }
        return 0;
      }

      case 'bench': {
        const client = createClient(buildClientOptions(parsed, effectiveEnv));
        const clientMeta: BenchClientMeta = {
          provider: client.provider,
          model: client.model,
          baseUrl: client.baseUrl,
        };

        const benchOptions: BenchOptions = {
          cwd,
          think: parsed.think,
          secrets: envSecrets,
        };
        if (parsed.casesDir !== undefined) {
          benchOptions.casesDir = path.resolve(cwd, parsed.casesDir);
        }
        if (parsed.caseId !== undefined) {
          benchOptions.caseId = parsed.caseId;
        }
        if (parsed.status !== undefined) {
          benchOptions.status = parsed.status;
        }
        if (parsed.language !== undefined) {
          benchOptions.language = parsed.language;
        }
        if (parsed.limit !== undefined) {
          benchOptions.limit = parsed.limit;
        }
        if (parsed.delayMs !== undefined) {
          benchOptions.delayMs = parsed.delayMs;
        }
        if (parsed.outDir !== undefined) {
          benchOptions.outDir = path.resolve(cwd, parsed.outDir);
        }

        const report = await runBenchFn(benchOptions, client, clientMeta);
        if (parsed.json) {
          io.stdout(stringifyRedactedJson(report, envSecrets));
        } else {
          io.stdout(
            redactSecrets(formatBenchReport(report, envSecrets), envSecrets),
          );
        }
        return report.metrics.errors > 0 ? 1 : 0;
      }
    }
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = redactSecrets(rawMessage, envSecrets);
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
  const cliArgs = process.argv.slice(2);
  const hasExplicitEnvFile = cliArgs.some(
    (arg) => arg === '--env-file' || arg.startsWith('--env-file='),
  );
  if (!hasExplicitEnvFile) {
    loadEnv();
  }
  void runCli(cliArgs).then((code) => {
    process.exitCode = code;
  });
}
