import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CheckClientMeta, CheckOptions, CheckReport } from '../src/check.js';
import { runCli, type CliDependencies, type CliIo } from '../src/cli.js';
import type { OpenAICompatibleClientOptions } from '../src/clients/openai-compatible.js';
import { PROVIDER_NAMES } from '../src/clients/providers.js';
import type { LlmClient } from '../src/clients/types.js';
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

describe('preflight CLI help and bench', () => {
  it('prints updated usage with ollama default for --help, -h, empty args, and check --help', async () => {
    for (const argv of [['--help'], ['-h'], [], ['check', '--help']]) {
      const captured = createCapturedIo();
      const code = await runCli(argv, captured.io);
      const output = captured.stdout.join('\n');

      expect(code).toBe(0);
      expect(output).toContain('Usage: preflight <command>');
      expect(output).toContain('check                  Run scoped CI pre-checks');
      expect(output).toContain('explain <log>          Explain a CI failure log');
      expect(output).toContain('init --hook            Install optional git pre-push hook');
      expect(output).toContain('bench                  Run benchmark suite (not implemented)');
      expect(output).toContain(
        '--provider <ollama|groq|gemini|openrouter|openai|cerebras|custom>',
      );
      expect(output).toContain('default: ollama');
      expect(output).toContain('--model <name>');
      expect(output).toContain('--base <ref>');
      expect(output).toContain('--log <file>');
      expect(output).toContain('--timeout <seconds>');
      expect(output).toContain('--no-verify');
      expect(output).not.toContain('Phase 0');
      expect(captured.stderr).toEqual([]);
    }
  });

  it('prints "not implemented" and exits 0 for bench', async () => {
    const captured = createCapturedIo();
    const code = await runCli(['bench'], captured.io);

    expect(code).toBe(0);
    expect(captured.stdout).toEqual(['not implemented']);
    expect(captured.stderr).toEqual([]);
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
});
