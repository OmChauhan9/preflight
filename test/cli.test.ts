import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runBench,
  type BenchClientMeta,
  type BenchOptions,
  type BenchReport,
  type BenchStatusFilter,
} from '../src/bench/index.js';
import type { CheckClientMeta, CheckOptions, CheckReport } from '../src/check.js';
import {
  DEFAULT_CLI_LLM_TIMEOUT_MS,
  runCli,
  type CliDependencies,
  type CliIo,
} from '../src/cli.js';
import type { OpenAICompatibleClientOptions } from '../src/clients/openai-compatible.js';
import { PROVIDER_NAMES } from '../src/clients/providers.js';
import type { LlmClient } from '../src/clients/types.js';
import { loadEnv, resolveDefaultEnvPath } from '../src/env.js';
import type {
  ExplainClientMeta,
  ExplainOptions,
  ExplainResult,
} from '../src/explain/index.js';
import {
  PrePushHookError,
  type InstallPrePushHookOptions,
  type InstallPrePushHookResult,
} from '../src/hooks/index.js';
import { computeTelemetry } from '../src/telemetry/index.js';

const cliTestTempDirs: string[] = [];

function createCliTempDir(prefix = 'preflight-cli-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cliTestTempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cliTestTempDirs.length > 0) {
    const dir = cliTestTempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createCapturedIo(): {
  io: CliIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

function createFakeClient(
  options: OpenAICompatibleClientOptions = {},
): LlmClient {
  return {
    provider: options.provider ?? 'ollama',
    model: options.model ?? 'qwen2.5-coder:7b',
    baseUrl: 'http://localhost:11434/v1',
    chatCompletion: () =>
      Promise.reject(new Error('chatCompletion should not be called directly in CLI unit tests')),
  };
}

function makeCheckReport(
  verdict: CheckReport['verdict'],
  meta: CheckClientMeta = {
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    baseUrl: 'http://localhost:11434/v1',
  },
): CheckReport {
  const verdictMessage =
    verdict === 'passed'
      ? 'these checks passed'
      : verdict === 'failed'
        ? 'these checks failed'
        : 'no allowlisted checks were executed';

  return {
    verdict,
    verdictMessage,
    baseRef: 'main',
    changedFiles: verdict === 'no_checks_run' ? [] : ['src/cli.ts'],
    gather: {
      estimatedTokens: 320,
      truncatedSections: [],
      workflowCommandCount: 2,
      affectedTestCount: 1,
    },
    think: {
      likely_failures:
        verdict === 'no_checks_run'
          ? []
          : [
              {
                category: 'test',
                target: 'test/cli.test.ts',
                reason: 'CLI flags updated',
                file: 'src/cli.ts',
                line: 42,
                confidence: 0.9,
              },
            ],
      affected_jobs: verdict === 'no_checks_run' ? [] : ['verify'],
      commands: verdict === 'no_checks_run' ? [] : ['npm test'],
      notes:
        verdict === 'no_checks_run'
          ? 'No changes detected against main.'
          : 'Run unit tests.',
    },
    thinkAttempts: verdict === 'no_checks_run' ? 0 : 1,
    verify: {
      verdict,
      verdictMessage,
      results:
        verdict === 'no_checks_run'
          ? []
          : [
              {
                command: 'npm test',
                status: verdict === 'passed' ? 'passed' : 'failed',
                exitCode: verdict === 'passed' ? 0 : 1,
                durationMs: 45,
                stdout: verdict === 'passed' ? 'ok' : '',
                stderr: verdict === 'failed' ? 'Test failure details' : '',
                matchedWorkflowCommand: 'npm test',
              },
            ],
      refusedCommands: [],
      durationMs: verdict === 'no_checks_run' ? 0 : 45,
    },
    telemetry: computeTelemetry({
      provider: meta.provider,
      model: meta.model,
      base_url: meta.baseUrl,
      usage:
        verdict === 'no_checks_run'
          ? null
          : { prompt_tokens: 320, completion_tokens: 80, total_tokens: 400 },
      time_info: null,
      timing_ms: {
        gather_ms: 12,
        think_ms: verdict === 'no_checks_run' ? 0 : 160,
        verify_ms: verdict === 'no_checks_run' ? 0 : 45,
        total_wall_ms: verdict === 'no_checks_run' ? 12 : 217,
      },
    }),
  };
}

function makeExplainResult(
  source: string,
  meta: ExplainClientMeta = {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
): ExplainResult {
  return {
    source,
    output: {
      root_cause: 'Missing null guard in src/math.ts',
      failing_command: 'npm test',
      suggested_patch: 'Return 0 when input array is empty in src/math.ts.',
      explanation: 'The helper crashed with TypeError on empty input.',
    },
    attempts: 1,
    verification: {
      verdict: 'failed',
      verdictMessage: 'these checks failed',
      results: [
        {
          command: 'npm test',
          status: 'failed',
          exitCode: 1,
          durationMs: 38,
          stdout: '',
          stderr: 'TypeError: Cannot read properties of undefined',
          matchedWorkflowCommand: 'npm test',
        },
      ],
      refusedCommands: [],
      durationMs: 38,
    },
    telemetry: computeTelemetry({
      provider: meta.provider,
      model: meta.model,
      base_url: meta.baseUrl,
      usage: { prompt_tokens: 410, completion_tokens: 95, total_tokens: 505 },
      time_info: {
        queue_time: 0.01,
        prompt_time: 0.04,
        completion_time: 0.19,
        total_time: 0.24,
      },
      timing_ms: {
        gather_ms: 15,
        think_ms: 240,
        verify_ms: 38,
        total_wall_ms: 293,
      },
    }),
  };
}

interface MakeBenchReportOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  runTimestamp?: string;
  casesDir?: string;
  errors?: number;
  writtenFiles?: {
    summaryPath: string;
    resultsPath: string;
  };
}

function makeBenchReport(
  options: MakeBenchReportOptions = {},
  meta: BenchClientMeta = {
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    baseUrl: 'http://localhost:11434/v1',
  },
): BenchReport {
  const report: BenchReport = {
    mode: 'triage',
    provider: options.provider ?? meta.provider,
    model: options.model ?? meta.model,
    baseUrl: options.baseUrl ?? meta.baseUrl,
    runTimestamp: options.runTimestamp ?? '2026-01-01T00:00:00.000Z',
    casesDir: options.casesDir ?? '/repo/bench/cases',
    metrics: {
      totalCases: 2,
      failedCases: 1,
      passingCases: 1,
      caught: 1,
      commandCaught: 1,
      targetCaught: 1,
      missed: 0,
      falseAlarms: 0,
      allowlistRefusals: 0,
      errors: options.errors ?? 0,
      medianWallMs: 215.4,
      p95WallMs: 310.2,
      medianThinkMs: 198.1,
      medianTokPerSec: 74.5,
    },
    cases: [],
  };

  if (options.writtenFiles !== undefined) {
    report.writtenFiles = options.writtenFiles;
  }

  return report;
}

describe('preflight CLI help', () => {
  it('prints complete usage for all 4 commands with ollama default and zero stub markers', async () => {
    for (const argv of [
      ['--help'],
      ['-h'],
      [],
      ['check', '--help'],
      ['bench', '--help'],
    ]) {
      const captured = createCapturedIo();
      const code = await runCli(argv, captured.io);
      const output = captured.stdout.join('\n');

      expect(code).toBe(0);
      expect(output).toContain('Usage: preflight <command>');
      expect(output).toContain('check                  Run scoped CI pre-checks');
      expect(output).toContain('explain <log>          Explain a CI failure log');
      expect(output).toContain('init --hook            Install optional git pre-push hook');
      expect(output).toContain('bench                  Run curated benchmark suite');
      expect(output).toContain(
        '--provider <ollama|groq|gemini|openrouter|openai|cerebras|custom>',
      );
      expect(output).toContain('default: ollama');
      expect(output).toContain('--model <name>');
      expect(output).toContain('--env-file <path>');
      expect(output).toContain('--base <ref>');
      expect(output).toContain('--log <file>');
      expect(output).toContain('--timeout <seconds>');
      expect(output).toContain('--no-verify');
      expect(output).toContain('--cases-dir <dir>');
      expect(output).toContain('--case <id>');
      expect(output).toContain('--status <fail|pass|all>');
      expect(output).toContain('--language <lang>');
      expect(output).toContain('--limit <n>');
      expect(output).toContain('--delay <ms>');
      expect(output).toContain('--out <dir>');
      expect(output).not.toContain('not implemented');
      expect(output).not.toContain('Phase 0');
      expect(captured.stderr).toEqual([]);
    }
  });
});

describe('preflight CLI bench command', () => {
  it('runs bench with human-readable output and exits 0 when metrics.errors is 0', async () => {
    const captured = createCapturedIo();
    let capturedBenchOpts: BenchOptions | undefined;
    const runBenchFn = vi.fn(
      async (options: BenchOptions, _client: LlmClient, meta: BenchClientMeta) => {
        capturedBenchOpts = options;
        return makeBenchReport(
          {
            writtenFiles: {
              summaryPath: '/repo/bench/results/summary.md',
              resultsPath: '/repo/bench/results/results.json',
            },
          },
          meta,
        );
      },
    );

    const code = await runCli(['bench'], captured.io, {
      cwd: '/repo',
      env: {},
      createClient: (opts) => createFakeClient(opts),
      runBenchFn,
    });
    const output = captured.stdout.join('\n');

    expect(code).toBe(0);
    expect(runBenchFn).toHaveBeenCalledTimes(1);
    expect(capturedBenchOpts).toEqual({
      cwd: '/repo',
      think: false,
      secrets: [],
    });
    expect(output).toContain('ollama');
    expect(output).toContain('qwen2.5-coder:7b');
    expect(output).toContain('/repo/bench/results/summary.md');
    expect(output).toContain('/repo/bench/results/results.json');
    expect(output).not.toContain('not implemented');
    expect(captured.stderr).toEqual([]);
  });

  it('emits redacted JSON for bench --json and preserves valid JSON', async () => {
    const captured = createCapturedIo();
    const customSecret = 'bench-secret-token-xyz-7890';

    const code = await runCli(['bench', '--json'], captured.io, {
      cwd: '/repo',
      env: { PREFLIGHT_API_KEY: customSecret },
      createClient: (opts) => createFakeClient(opts),
      runBenchFn: async (_opts, _client, meta) =>
        makeBenchReport(
          {
            casesDir: `/repo/cases/${customSecret}`,
            writtenFiles: {
              summaryPath: `/repo/out/${customSecret}/summary.md`,
              resultsPath: '/repo/out/results.json',
            },
          },
          meta,
        ),
    });

    expect(code).toBe(0);
    expect(captured.stderr).toEqual([]);
    const rawJson = captured.stdout.join('\n');
    expect(rawJson).not.toContain(customSecret);
    expect(rawJson).toContain('[REDACTED]');
    const parsed = JSON.parse(rawJson) as BenchReport;
    expect(parsed.mode).toBe('triage');
    expect(parsed.provider).toBe('ollama');
    expect(parsed.casesDir).toContain('[REDACTED]');
    expect(parsed.casesDir).not.toContain(customSecret);
    expect(parsed.writtenFiles?.summaryPath).toContain('[REDACTED]');
    expect(parsed.writtenFiles?.summaryPath).not.toContain(customSecret);
    expect(parsed.metrics.errors).toBe(0);
  });

  it('redacts env secrets from human-readable bench output', async () => {
    const captured = createCapturedIo();
    const customSecret = 'bench-human-secret-5555';

    const code = await runCli(['bench'], captured.io, {
      cwd: '/repo',
      env: { GROQ_API_KEY: customSecret },
      createClient: (opts) => createFakeClient(opts),
      runBenchFn: async (_opts, _client, meta) =>
        makeBenchReport(
          {
            writtenFiles: {
              summaryPath: `/tmp/${customSecret}/summary.md`,
              resultsPath: `/tmp/${customSecret}/results.json`,
            },
          },
          meta,
        ),
    });

    const output = captured.stdout.join('\n');
    expect(code).toBe(0);
    expect(output).not.toContain(customSecret);
    expect(output).toContain('[REDACTED]');
    expect(captured.stderr).toEqual([]);
  });

  it('forwards --provider, --model, --cases-dir, --case, --status, --language, --limit, --out, and --think', async () => {
    const captured = createCapturedIo();
    let capturedClientOpts: OpenAICompatibleClientOptions | undefined;
    let capturedBenchOpts: BenchOptions | undefined;

    const code = await runCli(
      [
        'bench',
        '--provider',
        'groq',
        '--model',
        'llama-3.3-70b-versatile',
        '--cases-dir',
        'custom/cases',
        '--case',
        'fail-01-express-pr-7531',
        '--status',
        'fail',
        '--language',
        'javascript',
        '--limit',
        '3',
        '--out',
        'bench/results',
        '--think',
      ],
      captured.io,
      {
        cwd: '/workspace/app',
        env: { GROQ_API_KEY: 'test-groq-key' },
        createClient: (opts) => {
          capturedClientOpts = opts;
          return createFakeClient(opts);
        },
        runBenchFn: async (opts, _client, meta) => {
          capturedBenchOpts = opts;
          return makeBenchReport({}, meta);
        },
      },
    );

    expect(code).toBe(0);
    expect(capturedClientOpts?.provider).toBe('groq');
    expect(capturedClientOpts?.model).toBe('llama-3.3-70b-versatile');
    expect(capturedClientOpts?.timeoutMs).toBe(DEFAULT_CLI_LLM_TIMEOUT_MS);
    expect(capturedBenchOpts).toEqual({
      cwd: '/workspace/app',
      casesDir: path.resolve('/workspace/app', 'custom/cases'),
      caseId: 'fail-01-express-pr-7531',
      status: 'fail',
      language: 'javascript',
      limit: 3,
      outDir: path.resolve('/workspace/app', 'bench/results'),
      think: true,
      secrets: ['test-groq-key'],
    });
    expect(captured.stderr).toEqual([]);
  });

  it('supports = flag syntax and case-insensitive --status values for bench', async () => {
    const statuses: readonly BenchStatusFilter[] = ['fail', 'pass', 'all'];
    for (const status of statuses) {
      const captured = createCapturedIo();
      let capturedBenchOpts: BenchOptions | undefined;

      const code = await runCli(
        [
          '--provider=gemini',
          '--model=gemini-3.5-flash-lite',
          '--cases-dir=cases-alt',
          '--case=pass-01-express-pr-7578',
          `--status=${status.toUpperCase()}`,
          '--language=ts',
          '--limit=10',
          '--out=out-dir',
          '--think',
          '--json',
          'bench',
        ],
        captured.io,
        {
          cwd: '/repo',
          env: {},
          createClient: (opts) => createFakeClient(opts),
          runBenchFn: async (opts, _client, meta) => {
            capturedBenchOpts = opts;
            return makeBenchReport({}, meta);
          },
        },
      );

      expect(code).toBe(0);
      expect(capturedBenchOpts).toEqual({
        cwd: '/repo',
        casesDir: path.resolve('/repo', 'cases-alt'),
        caseId: 'pass-01-express-pr-7578',
        status,
        language: 'ts',
        limit: 10,
        outDir: path.resolve('/repo', 'out-dir'),
        think: true,
        secrets: [],
      });
      expect(captured.stderr).toEqual([]);
    }
  });

  it('parses --delay <ms> and passes delayMs to runBench', async () => {
    for (const testCase of [
      { argv: ['bench', '--delay', '4200'], expectedDelayMs: 4200 },
      { argv: ['bench', '--delay=4200'], expectedDelayMs: 4200 },
      { argv: ['bench', '--delay', '0'], expectedDelayMs: 0 },
    ]) {
      const captured = createCapturedIo();
      let capturedBenchOpts: BenchOptions | undefined;

      const code = await runCli(testCase.argv, captured.io, {
        cwd: '/repo',
        env: {},
        createClient: (opts) => createFakeClient(opts),
        runBenchFn: async (opts, _client, meta) => {
          capturedBenchOpts = opts;
          return makeBenchReport({}, meta);
        },
      });

      expect(code).toBe(0);
      expect(capturedBenchOpts).toEqual({
        cwd: '/repo',
        delayMs: testCase.expectedDelayMs,
        think: false,
        secrets: [],
      });
      expect(captured.stderr).toEqual([]);
    }
  });

  it('exits 1 when report.metrics.errors > 0 in both human and --json modes', async () => {
    for (const argv of [['bench'], ['bench', '--json']]) {
      const captured = createCapturedIo();
      const code = await runCli(argv, captured.io, {
        cwd: '/repo',
        env: {},
        createClient: (opts) => createFakeClient(opts),
        runBenchFn: async (_opts, _client, meta) =>
          makeBenchReport({ errors: 2 }, meta),
      });

      expect(code).toBe(1);
      expect(captured.stdout.length).toBeGreaterThan(0);
      expect(captured.stderr).toEqual([]);
      if (argv.includes('--json')) {
        const parsed = JSON.parse(captured.stdout.join('\n')) as BenchReport;
        expect(parsed.metrics.errors).toBe(2);
      }
    }
  });

  it('exits 1 with a redacted error on stderr when runBenchFn throws', async () => {
    const captured = createCapturedIo();
    const customSecret = 'bench-throw-secret-4242';

    const code = await runCli(['bench'], captured.io, {
      cwd: '/repo',
      env: { PREFLIGHT_API_KEY: customSecret },
      createClient: (opts) => createFakeClient(opts),
      runBenchFn: async () => {
        throw new Error(`Benchmark failed using ${customSecret}`);
      },
    });

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('Error:');
    expect(stderr).toContain('[REDACTED]');
    expect(stderr).not.toContain(customSecret);
  });
});

describe('preflight CLI check command', () => {
  it('runs check with human-readable output and exits 0 when checks pass', async () => {
    const captured = createCapturedIo();
    const runCheckFn = vi.fn(
      async (_options: CheckOptions, _client: LlmClient, meta: CheckClientMeta) =>
        makeCheckReport('passed', meta),
    );
    const deps: CliDependencies = {
      cwd: '/repo',
      env: {},
      createClient: (opts) => createFakeClient(opts),
      runCheckFn,
    };

    const code = await runCli(['check'], captured.io, deps);
    const output = captured.stdout.join('\n');

    expect(code).toBe(0);
    expect(runCheckFn).toHaveBeenCalledTimes(1);
    expect(output).toContain('Verdict: these checks passed');
    expect(output).toContain('Speed & Telemetry');
    expect(output.toLowerCase()).not.toContain('ci will pass');
    expect(captured.stderr).toEqual([]);
  });

  it('emits valid JSON with --json and exits 1 when checks fail', async () => {
    const captured = createCapturedIo();
    const runCheckFn = vi.fn(
      async (_options: CheckOptions, _client: LlmClient, meta: CheckClientMeta) =>
        makeCheckReport('failed', meta),
    );
    const deps: CliDependencies = {
      cwd: '/repo',
      env: {},
      createClient: (opts) => createFakeClient(opts),
      runCheckFn,
    };

    const code = await runCli(['check', '--json'], captured.io, deps);

    expect(code).toBe(1);
    expect(captured.stderr).toEqual([]);
    const parsed = JSON.parse(captured.stdout.join('\n')) as CheckReport;
    expect(parsed.verdict).toBe('failed');
    expect(parsed.verdictMessage).toBe('these checks failed');
    expect(parsed.telemetry.provider).toBe('ollama');
  });

  it('exits 0 when verdict is no_checks_run', async () => {
    const captured = createCapturedIo();
    const deps: CliDependencies = {
      cwd: '/repo',
      env: {},
      createClient: (opts) => createFakeClient(opts),
      runCheckFn: async (_opts, _client, meta) =>
        makeCheckReport('no_checks_run', meta),
    };

    const code = await runCli(['check'], captured.io, deps);

    expect(code).toBe(0);
    expect(captured.stdout.join('\n')).toContain(
      'Verdict: no allowlisted checks were executed',
    );
  });

  it.each(PROVIDER_NAMES)(
    'forwards --provider %s, --model, --base, --timeout, --log, and --think to check',
    async (provider) => {
      const captured = createCapturedIo();
      let capturedClientOpts: OpenAICompatibleClientOptions | undefined;
      let capturedCheckOpts: CheckOptions | undefined;

      const deps: CliDependencies = {
        cwd: '/workspace/app',
        env: { PREFLIGHT_API_KEY: 'test-key' },
        readFileFn: (filePath: string) => {
          expect(filePath).toBe(path.resolve('/workspace/app', 'logs/ci.log'));
          return 'FAIL test/sample.test.ts';
        },
        createClient: (opts) => {
          capturedClientOpts = opts;
          return createFakeClient(opts);
        },
        runCheckFn: async (opts, _client, meta) => {
          capturedCheckOpts = opts;
          return makeCheckReport('passed', meta);
        },
      };

      const code = await runCli(
        [
          'check',
          '--provider',
          provider,
          '--model',
          'custom-model',
          '--base',
          'origin/main',
          '--timeout',
          '30',
          '--log',
          'logs/ci.log',
          '--think',
        ],
        captured.io,
        deps,
      );

      expect(code).toBe(0);
      expect(capturedClientOpts?.provider).toBe(provider);
      expect(capturedClientOpts?.model).toBe('custom-model');
      expect(capturedCheckOpts).toEqual({
        cwd: '/workspace/app',
        baseRef: 'origin/main',
        recentCiLog: 'FAIL test/sample.test.ts',
        timeoutMs: 30_000,
        think: true,
      });
    },
  );
});

describe('preflight CLI explain command', () => {
  it('returns exit code 1 with a clear error when <log-url-or-file> is missing', async () => {
    const captured = createCapturedIo();
    const runExplainFn = vi.fn();

    const code = await runCli(['explain'], captured.io, { runExplainFn });

    expect(code).toBe(1);
    expect(runExplainFn).not.toHaveBeenCalled();
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('\n')).toContain('Missing required <log-url-or-file>');
  });

  it('runs explain with human-readable output and exits 0', async () => {
    const captured = createCapturedIo();
    let capturedExplainOpts: ExplainOptions | undefined;

    const deps: CliDependencies = {
      cwd: '/repo',
      env: {},
      createClient: (opts) => createFakeClient(opts),
      runExplainFn: async (opts, _client, meta) => {
        capturedExplainOpts = opts;
        return makeExplainResult(opts.source, meta);
      },
    };

    const code = await runCli(
      ['explain', 'ci.log', '--base=main', '--timeout=45', '--think'],
      captured.io,
      deps,
    );
    const output = captured.stdout.join('\n');

    expect(code).toBe(0);
    expect(capturedExplainOpts).toEqual({
      source: 'ci.log',
      cwd: '/repo',
      baseRef: 'main',
      timeoutMs: 45_000,
      think: true,
      verify: true,
    });
    expect(output).toContain('Missing null guard in src/math.ts');
    expect(output).toContain('Speed & Telemetry');
    expect(output.toLowerCase()).not.toContain('ci will pass');
    expect(captured.stderr).toEqual([]);
  });

  it('supports --json, --no-verify, and flags before subcommand for explain', async () => {
    const captured = createCapturedIo();
    let capturedClientOpts: OpenAICompatibleClientOptions | undefined;
    let capturedExplainOpts: ExplainOptions | undefined;

    const deps: CliDependencies = {
      cwd: '/repo',
      env: {},
      createClient: (opts) => {
        capturedClientOpts = opts;
        return createFakeClient(opts);
      },
      runExplainFn: async (opts, _client, meta) => {
        capturedExplainOpts = opts;
        return makeExplainResult(opts.source, meta);
      },
    };

    const code = await runCli(
      [
        '--json',
        '--provider=groq',
        '--model=llama-3.3-70b-versatile',
        '--no-verify',
        'explain',
        'https://github.com/org/repo/actions/runs/12345',
      ],
      captured.io,
      deps,
    );

    expect(code).toBe(0);
    expect(capturedClientOpts?.provider).toBe('groq');
    expect(capturedClientOpts?.model).toBe('llama-3.3-70b-versatile');
    expect(capturedExplainOpts).toEqual({
      source: 'https://github.com/org/repo/actions/runs/12345',
      cwd: '/repo',
      think: false,
      verify: false,
    });
    const parsed = JSON.parse(captured.stdout.join('\n')) as ExplainResult;
    expect(parsed.source).toBe('https://github.com/org/repo/actions/runs/12345');
    expect(parsed.output.root_cause).toBe('Missing null guard in src/math.ts');
  });
});

describe('preflight CLI init command', () => {
  it('installs the pre-push hook with init --hook and prints confirmation', async () => {
    const captured = createCapturedIo();
    const installHookFn = vi.fn(
      (_repoRoot: string, _options?: InstallPrePushHookOptions): InstallPrePushHookResult => ({
        hookPath: '/repo/.git/hooks/pre-push',
        status: 'installed',
      }),
    );

    const code = await runCli(['init', '--hook'], captured.io, {
      cwd: '/repo',
      installHookFn,
    });

    expect(code).toBe(0);
    expect(installHookFn).toHaveBeenCalledWith('/repo', { force: false });
    expect(captured.stdout.join('\n')).toContain(
      'Installed Preflight pre-push hook at /repo/.git/hooks/pre-push',
    );
    expect(captured.stdout.join('\n')).toContain('git push --no-verify');
    expect(captured.stderr).toEqual([]);
  });

  it('forwards --force and supports --json for init --hook', async () => {
    const captured = createCapturedIo();
    const installHookFn = vi.fn(
      (_repoRoot: string, _options?: InstallPrePushHookOptions): InstallPrePushHookResult => ({
        hookPath: '/repo/.git/hooks/pre-push',
        status: 'updated',
      }),
    );

    const code = await runCli(
      ['init', '--hook', '--force', '--json'],
      captured.io,
      { cwd: '/repo', installHookFn },
    );

    expect(code).toBe(0);
    expect(installHookFn).toHaveBeenCalledWith('/repo', { force: true });
    expect(JSON.parse(captured.stdout.join('\n'))).toEqual({
      hookPath: '/repo/.git/hooks/pre-push',
      status: 'updated',
    });
  });

  it('returns exit code 1 and prints error when installPrePushHook throws PrePushHookError', async () => {
    const captured = createCapturedIo();
    const installHookFn = vi.fn(() => {
      throw new PrePushHookError(
        'EXISTING_CUSTOM_HOOK',
        'Refusing to overwrite existing custom pre-push hook. Pass --force to replace it.',
      );
    });

    const code = await runCli(['init', '--hook'], captured.io, {
      cwd: '/repo',
      installHookFn,
    });

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('\n')).toContain(
      'Refusing to overwrite existing custom pre-push hook',
    );
  });
});

describe('preflight CLI validation and secret redaction', () => {
  it('returns exit code 1 for unknown command or unknown option', async () => {
    const unknownCmd = createCapturedIo();
    expect(await runCli(['unknown-cmd'], unknownCmd.io)).toBe(1);
    expect(unknownCmd.stderr.join('\n')).toContain('Unknown command: unknown-cmd');

    const unknownOpt = createCapturedIo();
    expect(await runCli(['check', '--unknown-flag'], unknownOpt.io)).toBe(1);
    expect(unknownOpt.stderr.join('\n')).toContain('Unknown option: --unknown-flag');
  });

  it('returns exit code 1 for missing or invalid flag values', async () => {
    const cases: Array<{ argv: string[]; expectedError: string }> = [
      { argv: ['check', '--provider'], expectedError: 'Missing value for --provider' },
      { argv: ['check', '--provider='], expectedError: 'Missing value for --provider' },
      { argv: ['check', '--provider', '--json'], expectedError: 'Missing value for --provider' },
      { argv: ['check', '--provider', 'unknown-provider'], expectedError: 'Unknown provider: unknown-provider' },
      { argv: ['check', '--provider=unknown-provider'], expectedError: 'Unknown provider: unknown-provider' },
      { argv: ['check', '--model'], expectedError: 'Missing value for --model' },
      { argv: ['check', '--model='], expectedError: 'Missing value for --model' },
      { argv: ['check', '--model', '--think'], expectedError: 'Missing value for --model' },
      { argv: ['check', '--base'], expectedError: 'Missing value for --base' },
      { argv: ['check', '--log'], expectedError: 'Missing value for --log' },
      { argv: ['check', '--timeout'], expectedError: 'Missing value for --timeout' },
      { argv: ['check', '--timeout', '0'], expectedError: 'Invalid value for --timeout' },
      { argv: ['check', '--timeout', '-5'], expectedError: 'Invalid value for --timeout' },
      { argv: ['check', '--timeout=abc'], expectedError: 'Invalid value for --timeout' },
      { argv: ['bench', '--cases-dir'], expectedError: 'Missing value for --cases-dir' },
      { argv: ['bench', '--cases-dir='], expectedError: 'Missing value for --cases-dir' },
      { argv: ['bench', '--cases-dir', '--json'], expectedError: 'Missing value for --cases-dir' },
      { argv: ['bench', '--case'], expectedError: 'Missing value for --case' },
      { argv: ['bench', '--case='], expectedError: 'Missing value for --case' },
      { argv: ['bench', '--status'], expectedError: 'Missing value for --status' },
      { argv: ['bench', '--status='], expectedError: 'Missing value for --status' },
      { argv: ['bench', '--status', '--json'], expectedError: 'Missing value for --status' },
      { argv: ['bench', '--status', 'invalid'], expectedError: 'Invalid value for --status' },
      { argv: ['bench', '--status=broken'], expectedError: 'Invalid value for --status' },
      { argv: ['bench', '--language'], expectedError: 'Missing value for --language' },
      { argv: ['bench', '--language='], expectedError: 'Missing value for --language' },
      { argv: ['bench', '--limit'], expectedError: 'Missing value for --limit' },
      { argv: ['bench', '--limit='], expectedError: 'Missing value for --limit' },
      { argv: ['bench', '--limit', '--json'], expectedError: 'Missing value for --limit' },
      { argv: ['bench', '--limit', '0'], expectedError: 'Invalid value for --limit' },
      { argv: ['bench', '--limit', '-3'], expectedError: 'Invalid value for --limit' },
      { argv: ['bench', '--limit=2.5'], expectedError: 'Invalid value for --limit' },
      { argv: ['bench', '--limit=abc'], expectedError: 'Invalid value for --limit' },
      { argv: ['bench', '--delay'], expectedError: 'Missing value for --delay' },
      { argv: ['bench', '--delay='], expectedError: 'Missing value for --delay' },
      { argv: ['bench', '--delay', '--json'], expectedError: 'Missing value for --delay' },
      { argv: ['bench', '--delay', '-1'], expectedError: 'Invalid value for --delay' },
      { argv: ['bench', '--delay=-1'], expectedError: 'Invalid value for --delay' },
      { argv: ['bench', '--delay', 'abc'], expectedError: 'Invalid value for --delay' },
      { argv: ['bench', '--delay=abc'], expectedError: 'Invalid value for --delay' },
      { argv: ['bench', '--delay', '1.5'], expectedError: 'Invalid value for --delay' },
      { argv: ['bench', '--out'], expectedError: 'Missing value for --out' },
      { argv: ['bench', '--out='], expectedError: 'Missing value for --out' },
    ];

    for (const testCase of cases) {
      const captured = createCapturedIo();
      const code = await runCli(testCase.argv, captured.io);
      expect(code).toBe(1);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr.join('\n')).toContain(testCase.expectedError);
    }
  });

  it('redacts API keys and bearer tokens from thrown errors before writing to stderr', async () => {
    const captured = createCapturedIo();
    const customSecret = 'super-secret-custom-token-9999';
    const deps: CliDependencies = {
      cwd: '/repo',
      env: { PREFLIGHT_API_KEY: customSecret },
      createClient: (opts) => createFakeClient(opts),
      runCheckFn: async () => {
        throw new Error(
          `Request failed with Authorization: Bearer ${customSecret} and key gsk_1234567890abcdef1234`,
        );
      },
    };

    const code = await runCli(['check'], captured.io, deps);
    const stderr = captured.stderr.join('\n');

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(stderr).toContain('[REDACTED]');
    expect(stderr).not.toContain(customSecret);
    expect(stderr).not.toContain('gsk_1234567890abcdef1234');
  });

  it('redacts custom non-prefixed env secrets echoed in check and explain --json output while preserving valid JSON', async () => {
    const customSecret = 'my-unprefixed-env-secret-42';

    const checkIo = createCapturedIo();
    const checkCode = await runCli(['check', '--json'], checkIo.io, {
      cwd: '/repo',
      env: { PREFLIGHT_API_KEY: customSecret },
      createClient: (opts) => createFakeClient(opts),
      runCheckFn: async (_opts, _client, meta) => {
        const report = makeCheckReport('passed', meta);
        const firstResult = report.verify.results[0];
        if (firstResult) {
          firstResult.stdout = `echoed token=${customSecret} Authorization: Bearer ${customSecret}`;
        }
        return report;
      },
    });

    expect(checkCode).toBe(0);
    const checkJsonRaw = checkIo.stdout.join('\n');
    expect(checkJsonRaw).not.toContain(customSecret);
    expect(checkJsonRaw).toContain('[REDACTED]');
    const parsedCheck = JSON.parse(checkJsonRaw) as CheckReport;
    expect(parsedCheck.verify.results[0]?.stdout).toContain('[REDACTED]');
    expect(parsedCheck.verify.results[0]?.stdout).not.toContain(customSecret);

    const explainIo = createCapturedIo();
    const explainCode = await runCli(
      ['explain', 'ci.log', '--json'],
      explainIo.io,
      {
        cwd: '/repo',
        env: { PREFLIGHT_API_KEY: customSecret },
        createClient: (opts) => createFakeClient(opts),
        runExplainFn: async (opts, _client, meta) => {
          const result = makeExplainResult(opts.source, meta);
          const firstVerifyResult = result.verification?.results[0];
          if (firstVerifyResult) {
            firstVerifyResult.stderr = `failed using ${customSecret}`;
          }
          return result;
        },
      },
    );

    expect(explainCode).toBe(0);
    const explainJsonRaw = explainIo.stdout.join('\n');
    expect(explainJsonRaw).not.toContain(customSecret);
    expect(explainJsonRaw).toContain('[REDACTED]');
    const parsedExplain = JSON.parse(explainJsonRaw) as ExplainResult;
    expect(parsedExplain.verification?.results[0]?.stderr).toContain('[REDACTED]');
    expect(parsedExplain.verification?.results[0]?.stderr).not.toContain(customSecret);
  });

  it('requires --hook for preflight init and refuses to run without it', async () => {
    for (const argv of [['init'], ['init', '--force']]) {
      const captured = createCapturedIo();
      const installHookFn = vi.fn();

      const code = await runCli(argv, captured.io, {
        cwd: '/repo',
        installHookFn,
      });

      expect(code).toBe(1);
      expect(installHookFn).not.toHaveBeenCalled();
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr.join('\n')).toContain(
        'Missing required --hook flag for "init"',
      );
    }
  });

  it('rejects incompatible cross-command flags with a clear stderr error and exit 1', async () => {
    const invalidInvocations: Array<{ argv: string[]; flag: string; cmd: string }> = [
      { argv: ['check', '--no-verify'], flag: '--no-verify', cmd: 'check' },
      { argv: ['init', '--hook', '--no-verify'], flag: '--no-verify', cmd: 'init' },
      { argv: ['bench', '--no-verify'], flag: '--no-verify', cmd: 'bench' },
      { argv: ['check', '--hook'], flag: '--hook', cmd: 'check' },
      { argv: ['check', '--force'], flag: '--force', cmd: 'check' },
      { argv: ['explain', 'ci.log', '--hook'], flag: '--hook', cmd: 'explain' },
      { argv: ['explain', 'ci.log', '--force'], flag: '--force', cmd: 'explain' },
      { argv: ['bench', '--hook'], flag: '--hook', cmd: 'bench' },
      { argv: ['bench', '--force'], flag: '--force', cmd: 'bench' },
      { argv: ['check', '--cases-dir', 'cases'], flag: '--cases-dir', cmd: 'check' },
      { argv: ['check', '--case', 'fail-01'], flag: '--case', cmd: 'check' },
      { argv: ['check', '--status', 'fail'], flag: '--status', cmd: 'check' },
      { argv: ['check', '--language', 'python'], flag: '--language', cmd: 'check' },
      { argv: ['check', '--limit', '2'], flag: '--limit', cmd: 'check' },
      { argv: ['check', '--delay', '100'], flag: '--delay', cmd: 'check' },
      { argv: ['check', '--out', 'out'], flag: '--out', cmd: 'check' },
      { argv: ['explain', 'ci.log', '--cases-dir', 'cases'], flag: '--cases-dir', cmd: 'explain' },
      { argv: ['explain', 'ci.log', '--delay', '100'], flag: '--delay', cmd: 'explain' },
      { argv: ['explain', 'ci.log', '--out', 'out'], flag: '--out', cmd: 'explain' },
      { argv: ['init', '--hook', '--limit', '2'], flag: '--limit', cmd: 'init' },
      { argv: ['init', '--hook', '--delay', '100'], flag: '--delay', cmd: 'init' },
      { argv: ['init', '--hook', '--base', 'main'], flag: '--base', cmd: 'init' },
      { argv: ['init', '--hook', '--log', 'ci.log'], flag: '--log', cmd: 'init' },
      { argv: ['bench', '--base', 'main'], flag: '--base', cmd: 'bench' },
      { argv: ['bench', '--log', 'ci.log'], flag: '--log', cmd: 'bench' },
      { argv: ['explain', 'ci.log', '--log', 'other.log'], flag: '--log', cmd: 'explain' },
      { argv: ['init', '--hook', '--provider', 'groq'], flag: '--provider', cmd: 'init' },
      { argv: ['bench', '--timeout', '30'], flag: '--timeout', cmd: 'bench' },
    ];

    for (const testCase of invalidInvocations) {
      const captured = createCapturedIo();
      const code = await runCli(testCase.argv, captured.io, {
        cwd: '/repo',
        env: {},
        createClient: () => {
          throw new Error('createClient must not be called on incompatible flags');
        },
        installHookFn: () => {
          throw new Error('installHookFn must not be called on incompatible flags');
        },
      });

      expect(code).toBe(1);
      expect(captured.stdout).toEqual([]);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain(testCase.flag);
      expect(stderr).toContain(`"${testCase.cmd}"`);
    }
  });

  it('passes default 120s LLM timeoutMs when creating CLI clients for check, explain, and bench', async () => {
    expect(DEFAULT_CLI_LLM_TIMEOUT_MS).toBe(120_000);

    const seenTimeouts: number[] = [];
    const deps: CliDependencies = {
      cwd: '/repo',
      env: {},
      createClient: (opts) => {
        if (opts.timeoutMs !== undefined) {
          seenTimeouts.push(opts.timeoutMs);
        }
        return createFakeClient(opts);
      },
      runCheckFn: async (_o, _c, meta) => makeCheckReport('passed', meta),
      runExplainFn: async (o, _c, meta) => makeExplainResult(o.source, meta),
      runBenchFn: async (_o, _c, meta) => makeBenchReport({}, meta),
    };

    expect(await runCli(['check'], createCapturedIo().io, deps)).toBe(0);
    expect(await runCli(['explain', 'ci.log'], createCapturedIo().io, deps)).toBe(0);
    expect(await runCli(['bench'], createCapturedIo().io, deps)).toBe(0);
    expect(seenTimeouts).toEqual([120_000, 120_000, 120_000]);
  });

  it('loads --env-file explicitly without auto-loading target repo .env and redacts secrets loaded from --env-file', async () => {
    const tempRoot = createCliTempDir('preflight-envfile-');
    const explicitEnvPath = path.join(tempRoot, 'custom.env');
    const loadedSecret = 'loaded-env-file-secret-12345';
    writeFileSync(
      explicitEnvPath,
      [
        'PREFLIGHT_PROVIDER=groq',
        'PREFLIGHT_MODEL=llama-3.3-70b-versatile',
        `PREFLIGHT_API_KEY=${loadedSecret}`,
        'EXISTING_VAR=from-file',
      ].join('\n'),
      'utf8',
    );

    let capturedClientEnv: Record<string, string | undefined> | undefined;
    const captured = createCapturedIo();
    const code = await runCli(
      ['check', '--env-file', 'custom.env'],
      captured.io,
      {
        cwd: tempRoot,
        env: { EXISTING_VAR: 'from-shell' },
        createClient: (opts) => {
          capturedClientEnv = { ...opts.env };
          return createFakeClient(opts);
        },
        runCheckFn: async () => {
          throw new Error(`Leaked ${loadedSecret}`);
        },
      },
    );

    expect(code).toBe(1);
    expect(capturedClientEnv?.PREFLIGHT_PROVIDER).toBe('groq');
    expect(capturedClientEnv?.PREFLIGHT_API_KEY).toBe(loadedSecret);
    // Existing shell env vars are never overridden by --env-file.
    expect(capturedClientEnv?.EXISTING_VAR).toBe('from-shell');
    // Secret loaded from --env-file is redacted from stderr.
    expect(captured.stderr.join('\n')).toContain('[REDACTED]');
    expect(captured.stderr.join('\n')).not.toContain(loadedSecret);

    // Rejects missing or whitespace-only --env-file values and missing files.
    for (const badArgv of [
      ['check', '--env-file'],
      ['check', '--env-file='],
      ['check', '--env-file', '   '],
      ['check', '--env-file', '--json'],
    ]) {
      const badIo = createCapturedIo();
      expect(await runCli(badArgv, badIo.io, { cwd: tempRoot, env: {} })).toBe(1);
      expect(badIo.stderr.join('\n')).toContain('Missing value for --env-file');
    }

    const missingFileIo = createCapturedIo();
    expect(
      await runCli(
        ['check', '--env-file', 'does-not-exist.env'],
        missingFileIo.io,
        { cwd: tempRoot, env: {} },
      ),
    ).toBe(1);
    expect(missingFileIo.stderr.join('\n')).toContain('Failed to load env file');
  });

  it('forwards envSecrets to runBench so --out summary.md and results.json redact custom secrets', async () => {
    const tempRoot = createCliTempDir('preflight-cli-bench-out-');
    const casesDir = path.join(tempRoot, 'cases');
    const outDir = path.join(tempRoot, 'out');
    mkdirSync(casesDir, { recursive: true });
    writeFileSync(
      path.join(casesDir, '01.json'),
      JSON.stringify({
        id: 'fail-secret-case',
        status: 'fail',
        repo: 'expressjs/express',
        pr: 1,
        pr_url: 'https://github.com/expressjs/express/pull/1',
        language: 'javascript',
        base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        workflow_file: '.github/workflows/ci.yml',
        run_id: 1,
        run_url: 'https://github.com/expressjs/express/actions/runs/1',
        failing_job: 'test',
        failing_command: 'npm run test-ci',
        log_excerpt: 'Error',
        changed_files: ['lib/application.js'],
        root_cause_label: 'unit_test: lib/application.js failed',
        label_verified: {
          checked_against_log: true,
          checked_against_diff: true,
          notes: 'ok',
        },
      }),
      'utf8',
    );

    const customSecret = 'cli-bench-out-unprefixed-secret-8888';
    const captured = createCapturedIo();
    const code = await runCli(
      ['bench', '--cases-dir', casesDir, '--out', outDir],
      captured.io,
      {
        cwd: tempRoot,
        env: { PREFLIGHT_API_KEY: customSecret },
        createClient: () => ({
          provider: 'custom',
          model: 'local-coder',
          baseUrl: `https://proxy.example.com/v1?x=${customSecret}`,
          chatCompletion: () =>
            Promise.reject(new Error(`Upstream blew up with ${customSecret}`)),
        }),
        runBenchFn: runBench,
      },
    );

    expect(code).toBe(1);
    const summaryDisk = readFileSync(path.join(outDir, 'summary.md'), 'utf8');
    const resultsDisk = readFileSync(path.join(outDir, 'results.json'), 'utf8');
    expect(summaryDisk).not.toContain(customSecret);
    expect(summaryDisk).toContain('[REDACTED]');
    expect(resultsDisk).not.toContain(customSecret);
    expect(resultsDisk).toContain('[REDACTED]');
  });
});

describe('loadEnv security isolation', () => {
  it('resolves user config path via XDG_CONFIG_HOME or ~/.config/preflight/.env and never auto-loads cwd/.env', () => {
    const tempHome = createCliTempDir('preflight-env-home-');
    const fakeXdg = path.join(tempHome, 'xdg');
    const xdgEnvPath = path.join(fakeXdg, 'preflight', '.env');
    const homeEnvPath = path.join(tempHome, '.config', 'preflight', '.env');

    expect(resolveDefaultEnvPath({ XDG_CONFIG_HOME: fakeXdg }, tempHome)).toBe(
      xdgEnvPath,
    );
    expect(resolveDefaultEnvPath({}, tempHome)).toBe(homeEnvPath);

    // Put a malicious .env in a directory simulating a repo cwd; loadEnv() with no args ignores it.
    const untrustedRepo = createCliTempDir('preflight-untrusted-repo-');
    writeFileSync(
      path.join(untrustedRepo, '.env'),
      'PREFLIGHT_BASE_URL=https://evil.example/v1\n',
      'utf8',
    );

    const emptyHomeEnv: Record<string, string | undefined> = {};
    loadEnv(undefined, { targetEnv: emptyHomeEnv, homeDir: tempHome });
    expect(emptyHomeEnv.PREFLIGHT_BASE_URL).toBeUndefined();

    // Loads ~/.config/preflight/.env when present without overriding existing vars.
    mkdirSync(path.dirname(homeEnvPath), { recursive: true });
    writeFileSync(
      homeEnvPath,
      'PREFLIGHT_PROVIDER=groq\nGROQ_API_KEY=from-user-config\n',
      'utf8',
    );
    const homeTarget: Record<string, string | undefined> = {
      GROQ_API_KEY: 'already-set-in-shell',
    };
    loadEnv(undefined, { targetEnv: homeTarget, homeDir: tempHome });
    expect(homeTarget.PREFLIGHT_PROVIDER).toBe('groq');
    expect(homeTarget.GROQ_API_KEY).toBe('already-set-in-shell');

    // Prefers $XDG_CONFIG_HOME/preflight/.env when XDG_CONFIG_HOME is set.
    mkdirSync(path.dirname(xdgEnvPath), { recursive: true });
    writeFileSync(xdgEnvPath, 'PREFLIGHT_PROVIDER=cerebras\n', 'utf8');
    const xdgTarget: Record<string, string | undefined> = {
      XDG_CONFIG_HOME: fakeXdg,
    };
    loadEnv(undefined, { targetEnv: xdgTarget, homeDir: tempHome });
    expect(xdgTarget.PREFLIGHT_PROVIDER).toBe('cerebras');

    // Loads explicit path when passed and throws if empty or missing.
    const explicitTarget: Record<string, string | undefined> = {};
    loadEnv(path.join(untrustedRepo, '.env'), { targetEnv: explicitTarget });
    expect(explicitTarget.PREFLIGHT_BASE_URL).toBe('https://evil.example/v1');

    expect(() => loadEnv('   ', { targetEnv: {} })).toThrow(/non-empty/i);
    expect(() =>
      loadEnv(path.join(tempHome, 'missing.env'), { targetEnv: {} }),
    ).toThrow(/Failed to load env file/);
  });
});
