import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateBenchMetrics,
  buildDefaultCaseContext,
  formatBenchReport,
  loadBenchCases,
  percentile,
  renderBenchSummaryMarkdown,
  runBench,
  scoreBenchCase,
  type BenchCase,
  type BenchCaseResult,
  type BenchClientMeta,
} from '../src/bench/index.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  LlmClient,
} from '../src/clients/types.js';
import type { ThinkOutput } from '../src/think/index.js';
import {
  checkCommandAllowlist,
  type VerifyWorkflowCommand,
} from '../src/verify/index.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeMockCompletion(
  content: string,
  options?: {
    promptTokens?: number;
    completionTokens?: number;
    completionTimeSec?: number;
    wallTimeMs?: number;
  },
): ChatCompletionResult {
  const promptTokens = options?.promptTokens ?? 300;
  const completionTokens = options?.completionTokens ?? 80;
  const wallTimeMs = options?.wallTimeMs ?? 200;
  const timeInfo =
    options?.completionTimeSec !== undefined
      ? {
          queue_time: 0.005,
          prompt_time: 0.02,
          completion_time: options.completionTimeSec,
          total_time: 0.025 + options.completionTimeSec,
        }
      : null;

  return {
    raw: {
      id: 'chatcmpl-bench-mock',
      model: 'qwen2.5-coder:7b',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      time_info: timeInfo,
    },
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    time_info: timeInfo,
    wallTimeMs,
    status: 200,
  };
}

function makeSampleFailCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return {
    id: 'fail-01-express-pr-7531',
    status: 'fail',
    repo: 'expressjs/express',
    pr: 7531,
    pr_url: 'https://github.com/expressjs/express/pull/7531',
    language: 'javascript',
    base_sha: '0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8',
    head_sha: '5ebf19adabb6e0741eda1fecadecee9f6543ba49',
    workflow_file: '.github/workflows/ci.yml',
    run_id: 44581270820,
    run_url: 'https://github.com/expressjs/express/actions/runs/44581270820',
    failing_job: 'Node.js 18 - ubuntu-latest',
    failing_command: 'npm run test-ci',
    log_excerpt:
      'TypeError: Cannot read properties of undefined (reading router) at test/app.listRoutes.js:165:44',
    changed_files: ['lib/application.js', 'package.json', 'test/app.listRoutes.js'],
    root_cause_label:
      'unit_test: lib/application.js:240-244 & test/app.listRoutes.js — mounted sub-app router missing',
    label_verified: {
      checked_against_log: true,
      checked_against_diff: true,
      notes: 'Verified against CI log and diff.',
    },
    ...overrides,
  };
}

function makeSamplePassCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return {
    id: 'pass-01-express-pr-7578',
    status: 'pass',
    repo: 'expressjs/express',
    pr: 7578,
    pr_url: 'https://github.com/expressjs/express/pull/7578',
    language: 'javascript',
    base_sha: '1c6f1b0fe4000977b9a7b4f34097e4d527dd9824',
    head_sha: '12cceb843d2a14f5954042453ec54640a7e6056d',
    workflow_file: '.github/workflows/ci.yml',
    run_id: 41311401799,
    run_url: 'https://github.com/expressjs/express/actions/runs/41311401799',
    failing_job: null,
    failing_command: null,
    log_excerpt: null,
    changed_files: ['lib/response.js', 'test/res.links.js'],
    root_cause_label:
      'passing: early-return in res.links() in lib/response.js when given null/empty object',
    label_verified: {
      checked_against_log: true,
      checked_against_diff: true,
      notes: 'CI workflow succeeded on head_sha; verified code diff.',
    },
    ...overrides,
  };
}

describe('loadBenchCases', () => {
  it('loads and validates all 35 real bench/cases/*.json files (25 fail + 10 pass)', () => {
    const cases = loadBenchCases({ cwd: REPO_ROOT });

    expect(cases).toHaveLength(35);
    const failed = cases.filter((item) => item.status === 'fail');
    const passing = cases.filter((item) => item.status === 'pass');
    expect(failed).toHaveLength(25);
    expect(passing).toHaveLength(10);

    // Deterministic sorted filename order
    expect(cases[0]?.id).toBe('fail-01-express-pr-7531');
    expect(cases[34]?.id).toBe('pass-10-pydantic-settings-pr-1163');

    for (const item of cases) {
      expect(item.changed_files.length).toBeGreaterThan(0);
      expect(item.label_verified.checked_against_log).toBe(true);
      expect(item.label_verified.checked_against_diff).toBe(true);
    }
  });

  it('filters by caseId, status, case-insensitive language, and limit', () => {
    const single = loadBenchCases({
      cwd: REPO_ROOT,
      caseId: 'fail-01-express-pr-7531',
    });
    expect(single).toHaveLength(1);
    expect(single[0]?.pr).toBe(7531);

    const failOnly = loadBenchCases({ cwd: REPO_ROOT, status: 'fail' });
    expect(failOnly).toHaveLength(25);
    expect(failOnly.every((item) => item.status === 'fail')).toBe(true);

    const passOnly = loadBenchCases({ cwd: REPO_ROOT, status: 'pass' });
    expect(passOnly).toHaveLength(10);
    expect(passOnly.every((item) => item.status === 'pass')).toBe(true);

    const allStatus = loadBenchCases({ cwd: REPO_ROOT, status: 'all' });
    expect(allStatus).toHaveLength(35);

    const pythonCases = loadBenchCases({ cwd: REPO_ROOT, language: 'Python' });
    expect(pythonCases).toHaveLength(21);
    expect(pythonCases.every((item) => item.language.toLowerCase() === 'python')).toBe(true);

    const tsCases = loadBenchCases({ cwd: REPO_ROOT, language: 'TYPESCRIPT' });
    expect(tsCases).toHaveLength(8);

    const jsCases = loadBenchCases({ cwd: REPO_ROOT, language: 'javascript' });
    expect(jsCases).toHaveLength(6);

    const limited = loadBenchCases({
      cwd: REPO_ROOT,
      status: 'fail',
      language: 'python',
      limit: 3,
    });
    expect(limited).toHaveLength(3);
    expect(limited.every((item) => item.status === 'fail' && item.language === 'python')).toBe(
      true,
    );
  });

  it('throws clear errors for unknown caseId, missing directory, invalid limit, malformed JSON, and missing fields', () => {
    expect(() =>
      loadBenchCases({ cwd: REPO_ROOT, caseId: 'does-not-exist' }),
    ).toThrow(/not found/i);

    expect(() =>
      loadBenchCases({ cwd: REPO_ROOT, casesDir: 'bench/nonexistent-dir' }),
    ).toThrow(/directory not found/i);

    expect(() => loadBenchCases({ cwd: REPO_ROOT, limit: 0 })).toThrow(RangeError);
    expect(() => loadBenchCases({ cwd: REPO_ROOT, limit: -2 })).toThrow(RangeError);
    expect(() => loadBenchCases({ cwd: REPO_ROOT, limit: 1.5 })).toThrow(RangeError);

    const malformedDir = createTempDir('preflight-bench-malformed-');
    writeFileSync(path.join(malformedDir, 'broken.json'), '{ not valid json', 'utf8');
    expect(() =>
      loadBenchCases({ cwd: REPO_ROOT, casesDir: malformedDir }),
    ).toThrow(/malformed json/i);

    const incompleteDir = createTempDir('preflight-bench-incomplete-');
    writeFileSync(
      path.join(incompleteDir, 'missing.json'),
      JSON.stringify({ id: 'x', status: 'fail' }),
      'utf8',
    );
    expect(() =>
      loadBenchCases({ cwd: REPO_ROOT, casesDir: incompleteDir }),
    ).toThrow(/missing required field/i);
  });
});

describe('buildDefaultCaseContext', () => {
  it('never leaks root_cause_label, log_excerpt, or ground-truth status across all 35 real cases', () => {
    const cases = loadBenchCases({ cwd: REPO_ROOT });

    for (const benchCase of cases) {
      const ctx = buildDefaultCaseContext(benchCase);

      expect(ctx.budgetedContext).toContain(benchCase.repo);
      expect(ctx.budgetedContext).toContain(benchCase.base_sha);
      expect(ctx.budgetedContext).toContain(benchCase.head_sha);
      expect(ctx.budgetedContext).toContain(benchCase.workflow_file);

      // Zero leakage of ground truth
      expect(ctx.budgetedContext).not.toContain(benchCase.root_cause_label);
      expect(ctx.budgetedContext).not.toContain(benchCase.id);
      expect(ctx.budgetedContext).not.toMatch(/"status"\s*:\s*"(?:fail|pass)"/i);
      expect(ctx.budgetedContext).not.toMatch(/\bstatus\s*:\s*(?:fail|pass)\b/i);

      if (benchCase.log_excerpt !== null) {
        const firstLine = benchCase.log_excerpt
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.length >= 20);
        if (firstLine !== undefined) {
          expect(ctx.budgetedContext).not.toContain(firstLine);
        }
        expect(ctx.budgetedContext).not.toContain(benchCase.log_excerpt);
      }

      // Every fail case's canonical failing_command must be allowlisted by its workflowCommands
      expect(ctx.workflowCommands.length).toBeGreaterThan(0);
      if (benchCase.status === 'fail' && benchCase.failing_command !== null) {
        const decision = checkCommandAllowlist(
          benchCase.failing_command,
          ctx.workflowCommands,
        );
        expect(decision.allowed).toBe(true);
      }
    }
  });

  it('produces identical workflow commands for fail and pass cases of the same repo and respects maxInputTokens', () => {
    const failCase = makeSampleFailCase();
    const passCase = makeSamplePassCase();

    const failCtx = buildDefaultCaseContext(failCase);
    const passCtx = buildDefaultCaseContext(passCase);
    expect(failCtx.workflowCommands).toEqual(passCtx.workflowCommands);

    const tinyCtx = buildDefaultCaseContext(failCase, 25);
    expect(tinyCtx.budgetedContext.length).toBeLessThanOrEqual(100);
    expect(tinyCtx.budgetedContext).toContain('...[truncated]');
  });

  it('produces identical workflowCommands and budgetedContext for synthetic unknown-repo fail vs pass cases without leaking unlisted failing_command', () => {
    const shared = {
      repo: 'acme/unlisted-repo',
      pr: 42,
      pr_url: 'https://github.com/acme/unlisted-repo/pull/42',
      language: 'typescript',
      base_sha: '1111111111111111111111111111111111111111',
      head_sha: '2222222222222222222222222222222222222222',
      workflow_file: '.github/workflows/ci.yml',
      changed_files: ['src/index.ts', 'test/index.test.ts'],
    };

    const syntheticFail = makeSampleFailCase({
      ...shared,
      id: 'fail-synthetic-42',
      failing_job: 'custom-ci-job',
      failing_command: 'custom-unlisted-runner --strict',
    });
    const syntheticPass = makeSamplePassCase({
      ...shared,
      id: 'pass-synthetic-42',
    });

    const failCtx = buildDefaultCaseContext(syntheticFail);
    const passCtx = buildDefaultCaseContext(syntheticPass);

    expect(failCtx.workflowCommands).toEqual(passCtx.workflowCommands);
    expect(failCtx.budgetedContext).toBe(passCtx.budgetedContext);
    expect(failCtx.budgetedContext).not.toContain('custom-unlisted-runner');
  });
});

describe('scoreBenchCase', () => {
  const expressWorkflows: VerifyWorkflowCommand[] = [
    { file: '.github/workflows/ci.yml', job: 'test', command: 'npm run test-ci' },
    { file: '.github/workflows/ci.yml', job: 'lint', command: 'npm run lint' },
  ];

  it('marks a failed case caught by an allowlisted command (exact or scoped)', () => {
    const benchCase = makeSampleFailCase();
    const thinkOutput: ThinkOutput = {
      likely_failures: [],
      affected_jobs: ['test'],
      commands: ['npm run test-ci -- test/app.listRoutes.js'],
      notes: 'Run express CI tests scoped to app.listRoutes.',
    };

    const score = scoreBenchCase(benchCase, thinkOutput, expressWorkflows);
    expect(score.commandCaught).toBe(true);
    expect(score.targetCaught).toBe(false);
    expect(score.caught).toBe(true);
    expect(score.falseAlarm).toBeNull();
    expect(score.allowedCommands).toEqual([
      'npm run test-ci -- test/app.listRoutes.js',
    ]);
    expect(score.refusedCommands).toEqual([]);
  });

  it('marks a failed case caught by target only when command is wrong or refused', () => {
    const benchCase = makeSampleFailCase();
    const thinkOutput: ThinkOutput = {
      likely_failures: [
        {
          category: 'test',
          target: 'app.listRoutes.js',
          reason: 'Sub-application router getter in lib/application.js may break route listing.',
        },
      ],
      affected_jobs: ['lint'],
      commands: ['npm run lint'],
      notes: 'Only selected lint command.',
    };

    const score = scoreBenchCase(benchCase, thinkOutput, expressWorkflows);
    expect(score.commandCaught).toBe(false);
    expect(score.targetCaught).toBe(true);
    expect(score.caught).toBe(true);
    expect(score.falseAlarm).toBeNull();
    expect(score.allowedCommands).toEqual(['npm run lint']);
    expect(score.refusedCommands).toEqual([]);
  });

  it('marks a failed case missed when non-CI commands are refused and no target matches', () => {
    const benchCase = makeSampleFailCase();
    const thinkOutput: ThinkOutput = {
      likely_failures: [
        {
          category: 'test',
          target: 'test/unrelated.js',
          reason: 'Unrelated file check.',
        },
      ],
      affected_jobs: ['test'],
      commands: ['npx mocha test/app.listRoutes.js', 'npm run test-ci && echo pwned'],
      notes: 'Unallowlisted commands.',
    };

    const score = scoreBenchCase(benchCase, thinkOutput, expressWorkflows);
    expect(score.allowedCommands).toEqual([]);
    expect(score.refusedCommands).toHaveLength(2);
    expect(score.commandCaught).toBe(false);
    expect(score.targetCaught).toBe(false);
    expect(score.caught).toBe(false);
    expect(score.falseAlarm).toBeNull();
  });

  it('scores passing cases as clean (falseAlarm: false) or false alarm (falseAlarm: true)', () => {
    const passCase = makeSamplePassCase();

    const cleanOutput: ThinkOutput = {
      likely_failures: [],
      affected_jobs: ['test'],
      commands: ['npm run test-ci'],
      notes: 'Safe change; run standard test suite.',
    };
    const cleanScore = scoreBenchCase(passCase, cleanOutput, expressWorkflows);
    expect(cleanScore.caught).toBeNull();
    expect(cleanScore.commandCaught).toBeNull();
    expect(cleanScore.targetCaught).toBeNull();
    expect(cleanScore.falseAlarm).toBe(false);
    expect(cleanScore.allowedCommands).toEqual(['npm run test-ci']);
    expect(cleanScore.refusedCommands).toEqual([]);

    const alarmOutput: ThinkOutput = {
      likely_failures: [
        {
          category: 'test',
          target: 'test/res.links.js',
          reason: 'Predicted regression in res.links().',
        },
      ],
      affected_jobs: ['test'],
      commands: ['npm run test-ci'],
      notes: 'Flagged likely failure on a passing PR.',
    };
    const alarmScore = scoreBenchCase(passCase, alarmOutput, expressWorkflows);
    expect(alarmScore.caught).toBeNull();
    expect(alarmScore.commandCaught).toBeNull();
    expect(alarmScore.targetCaught).toBeNull();
    expect(alarmScore.falseAlarm).toBe(true);
  });
});

describe('percentile & aggregateBenchMetrics', () => {
  it('computes exact median (odd & even counts) and nearest-rank p95 with null handling', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();

    // Odd count
    expect(percentile([50, 10, 40, 20, 30], 50)).toBe(30);
    expect(percentile([50, 10, 40, 20, 30], 95)).toBe(50);

    // Even count midpoint average
    expect(percentile([40, 10, 30, 20], 50)).toBe(25);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    expect(percentile([10, 11], 50)).toBe(10.5);

    // Nearest-rank p95 on 20 and 21 elements
    const twenty = Array.from({ length: 20 }, (_, idx) => idx + 1);
    expect(percentile(twenty, 50)).toBe(10.5);
    expect(percentile(twenty, 95)).toBe(19);

    const twentyOne = Array.from({ length: 21 }, (_, idx) => idx + 1);
    expect(percentile(twentyOne, 50)).toBe(11);
    expect(percentile(twentyOne, 95)).toBe(20);
  });

  it('aggregates counts, refusals, errors, and non-null latency/throughput metrics accurately', () => {
    const baseResult: BenchCaseResult = {
      id: 'case-1',
      repo: 'expressjs/express',
      pr: 1,
      language: 'javascript',
      status: 'fail',
      caught: true,
      commandCaught: true,
      targetCaught: true,
      falseAlarm: null,
      predictedCommands: ['npm run test-ci'],
      allowedCommands: ['npm run test-ci'],
      refusedCommands: [],
      affectedJobs: ['test'],
      likelyFailureCount: 1,
      thinkAttempts: 1,
      wallTimeMs: 100,
      thinkMs: 90,
      tokPerSec: 40,
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      error: null,
    };

    const results: BenchCaseResult[] = [
      baseResult,
      {
        ...baseResult,
        id: 'case-2',
        caught: true,
        commandCaught: false,
        targetCaught: true,
        refusedCommands: [{ command: 'rm -rf /', reason: 'not allowlisted' }],
        wallTimeMs: 200,
        thinkMs: 180,
        tokPerSec: 60,
      },
      {
        ...baseResult,
        id: 'case-3',
        caught: false,
        commandCaught: false,
        targetCaught: false,
        wallTimeMs: 300,
        thinkMs: 270,
        tokPerSec: null,
      },
      {
        ...baseResult,
        id: 'case-4',
        status: 'pass',
        caught: null,
        commandCaught: null,
        targetCaught: null,
        falseAlarm: false,
        wallTimeMs: 400,
        thinkMs: 360,
        tokPerSec: 80,
      },
      {
        ...baseResult,
        id: 'case-5',
        status: 'pass',
        caught: null,
        commandCaught: null,
        targetCaught: null,
        falseAlarm: true,
        refusedCommands: [
          { command: 'curl evil', reason: 'not allowlisted' },
          { command: 'sh -c x', reason: 'not allowlisted' },
        ],
        wallTimeMs: 500,
        thinkMs: 450,
        tokPerSec: null,
        error: null,
      },
      {
        ...baseResult,
        id: 'case-6',
        status: 'fail',
        caught: null,
        commandCaught: null,
        targetCaught: null,
        falseAlarm: null,
        wallTimeMs: 600,
        thinkMs: 550,
        tokPerSec: null,
        error: 'HTTP 503',
      },
    ];

    const metrics = aggregateBenchMetrics(results);
    expect(metrics).toEqual({
      totalCases: 6,
      failedCases: 4,
      passingCases: 2,
      caught: 2,
      commandCaught: 1,
      targetCaught: 2,
      missed: 1,
      falseAlarms: 1,
      allowlistRefusals: 3,
      errors: 1,
      medianWallMs: 350,
      p95WallMs: 600,
      medianThinkMs: 315,
      medianTokPerSec: 60,
    });
  });
});

describe('runBench, renderBenchSummaryMarkdown, and formatBenchReport', () => {
  it('runs sequentially, recovers from per-case errors with secret redaction, and writes summary.md + results.json', async () => {
    const casesDir = createTempDir('preflight-bench-cases-');
    const outDir = createTempDir('preflight-bench-out-');

    const fail1 = makeSampleFailCase({ id: 'case-01-fail-ok' });
    const fail2 = makeSampleFailCase({
      id: 'case-02-fail-http-error',
      pr: 7532,
    });
    const pass1 = makeSamplePassCase({ id: 'case-03-pass-clean' });

    writeFileSync(path.join(casesDir, '01.json'), JSON.stringify(fail1), 'utf8');
    writeFileSync(path.join(casesDir, '02.json'), JSON.stringify(fail2), 'utf8');
    writeFileSync(path.join(casesDir, '03.json'), JSON.stringify(pass1), 'utf8');

    let inFlight = 0;
    let maxInFlight = 0;
    let callCount = 0;
    const seenPrompts: string[] = [];
    const seenRequests: ChatCompletionRequest[] = [];

    const mockClient: LlmClient = {
      provider: 'ollama',
      baseUrl: 'http://user:pass@localhost:11434/v1?api_key=sk-secret1234567890',
      model: 'qwen2.5-coder:7b',
      async chatCompletion(
        request: ChatCompletionRequest,
      ): Promise<ChatCompletionResult> {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seenRequests.push(request);
        seenPrompts.push(request.messages[1]?.content ?? '');

        // Brief async tick to verify sequential single-flight execution
        await new Promise((resolve) => setTimeout(resolve, 5));

        const currentCall = callCount;
        callCount += 1;
        inFlight -= 1;

        if (currentCall === 0) {
          const payload: ThinkOutput = {
            likely_failures: [
              {
                category: 'test',
                target: 'test/app.listRoutes.js',
                reason: 'Changed lib/application.js and test/app.listRoutes.js',
                file: 'lib/application.js',
              },
            ],
            affected_jobs: ['test'],
            commands: ['npm run test-ci'],
            notes: 'Run express CI tests.',
          };
          return makeMockCompletion(JSON.stringify(payload), {
            completionTokens: 100,
            completionTimeSec: 0.5,
            wallTimeMs: 520,
          });
        }

        if (currentCall === 1) {
          throw new Error(
            'Upstream API failed with Bearer sk-topsecretvalue1234567890',
          );
        }

        const passPayload: ThinkOutput = {
          likely_failures: [],
          affected_jobs: ['test'],
          commands: ['npm run test-ci'],
          notes: 'No likely failures predicted.',
        };
        return makeMockCompletion(JSON.stringify(passPayload), {
          completionTokens: 50,
          completionTimeSec: 0.25,
          wallTimeMs: 260,
        });
      },
    };

    const clientMeta: BenchClientMeta = {
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      baseUrl: 'http://user:pass@localhost:11434/v1?api_key=sk-secret1234567890',
    };

    const report = await runBench(
      {
        cwd: REPO_ROOT,
        casesDir,
        outDir,
        think: true,
        maxCompletionTokens: 1200,
      },
      mockClient,
      clientMeta,
    );

    // Strictly single-flight sequential order
    expect(maxInFlight).toBe(1);
    expect(callCount).toBe(3);
    expect(seenPrompts[0]).toContain('#7531');
    expect(seenPrompts[1]).toContain('#7532');
    expect(seenPrompts[2]).toContain('#7578');
    expect(seenRequests[0]?.reasoning_effort).toBe('low');
    expect(seenRequests[0]?.max_completion_tokens).toBe(1200);

    // Sanitized client metadata
    expect(report.mode).toBe('triage');
    expect(report.baseUrl).not.toContain('user:pass');
    expect(report.baseUrl).not.toContain('sk-secret1234567890');
    expect(report.baseUrl).toContain('[REDACTED]');

    // Per-case outcomes & error recovery
    expect(report.cases).toHaveLength(3);
    expect(report.cases[0]?.caught).toBe(true);
    expect(report.cases[0]?.commandCaught).toBe(true);
    expect(report.cases[0]?.targetCaught).toBe(true);
    expect(report.cases[0]?.tokPerSec).toBe(200);
    expect(report.cases[0]?.error).toBeNull();

    expect(report.cases[1]?.error).toContain('Upstream API failed');
    expect(report.cases[1]?.error).toContain('[REDACTED]');
    expect(report.cases[1]?.error).not.toContain('sk-topsecretvalue1234567890');
    expect(report.cases[1]?.caught).toBeNull();

    expect(report.cases[2]?.status).toBe('pass');
    expect(report.cases[2]?.falseAlarm).toBe(false);
    expect(report.cases[2]?.error).toBeNull();

    // Summary metrics
    expect(report.metrics.totalCases).toBe(3);
    expect(report.metrics.failedCases).toBe(2);
    expect(report.metrics.passingCases).toBe(1);
    expect(report.metrics.caught).toBe(1);
    expect(report.metrics.commandCaught).toBe(1);
    expect(report.metrics.targetCaught).toBe(1);
    expect(report.metrics.missed).toBe(0);
    expect(report.metrics.falseAlarms).toBe(0);
    expect(report.metrics.errors).toBe(1);
    expect(report.metrics.medianTokPerSec).toBe(200);

    // Written artifacts
    expect(report.writtenFiles).toBeDefined();
    const summaryPath = report.writtenFiles?.summaryPath ?? '';
    const resultsPath = report.writtenFiles?.resultsPath ?? '';
    expect(summaryPath).toBe(path.join(outDir, 'summary.md'));
    expect(resultsPath).toBe(path.join(outDir, 'results.json'));

    const summaryDisk = readFileSync(summaryPath, 'utf8');
    const resultsDisk = readFileSync(resultsPath, 'utf8');

    expect(summaryDisk).toContain('# Preflight Benchmark Summary');
    expect(summaryDisk).toContain('`triage`');
    expect(summaryDisk).toContain('Honesty Note');
    expect(summaryDisk).toContain('distinct from full local repository checkout');
    expect(summaryDisk).toContain('caught / failedCases');
    expect(summaryDisk).toContain('case-01-fail-ok');
    expect(summaryDisk).toContain('case-02-fail-http-error');
    expect(summaryDisk).toContain('case-03-pass-clean');
    expect(summaryDisk).not.toContain('sk-topsecretvalue1234567890');
    expect(summaryDisk).not.toContain('sk-secret1234567890');
    expect(summaryDisk).not.toContain('user:pass');

    const parsedJson = JSON.parse(resultsDisk) as typeof report;
    expect(parsedJson.mode).toBe('triage');
    expect(parsedJson.metrics.errors).toBe(1);
    expect(parsedJson.cases).toHaveLength(3);
    expect(resultsDisk).not.toContain('sk-topsecretvalue1234567890');
    expect(resultsDisk).not.toContain('sk-secret1234567890');

    // renderBenchSummaryMarkdown & formatBenchReport output checks
    const renderedMd = renderBenchSummaryMarkdown(report);
    expect(renderedMd).toContain('median_tok_per_s');
    expect(renderedMd).toContain('200.0 tok/s');

    const formattedCli = formatBenchReport(report);
    expect(formattedCli).toContain('Preflight Benchmark (triage)');
    expect(formattedCli).toContain('ollama / qwen2.5-coder:7b');
    expect(formattedCli).toContain('1 / 2');
    expect(formattedCli).toContain('0 / 1');
    expect(formattedCli).toContain('Allowlist refusals : 0');
    expect(formattedCli).toContain('Errors             : 1');
    expect(formattedCli).toContain('200.0 tok/s');
    expect(formattedCli).toContain(summaryPath);
    expect(formattedCli).toContain(resultsPath);
    expect(formattedCli).not.toContain('sk-topsecretvalue1234567890');
  });

  it('captures ThinkValidationError cleanly after 2 attempts without aborting subsequent cases', async () => {
    const casesDir = createTempDir('preflight-bench-validation-');
    const fail1 = makeSampleFailCase({ id: 'case-invalid-json' });
    const pass1 = makeSamplePassCase({ id: 'case-after-invalid' });

    writeFileSync(path.join(casesDir, '01.json'), JSON.stringify(fail1), 'utf8');
    writeFileSync(path.join(casesDir, '02.json'), JSON.stringify(pass1), 'utf8');

    let calls = 0;
    const mockClient: LlmClient = {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
      chatCompletion(): Promise<ChatCompletionResult> {
        calls += 1;
        if (calls <= 2) {
          return Promise.resolve(makeMockCompletion('not valid json at all'));
        }
        const ok: ThinkOutput = {
          likely_failures: [],
          affected_jobs: ['test'],
          commands: ['npm run test-ci'],
          notes: 'Recovered on next case.',
        };
        return Promise.resolve(makeMockCompletion(JSON.stringify(ok)));
      },
    };

    const report = await runBench(
      { cwd: REPO_ROOT, casesDir },
      mockClient,
      {
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        baseUrl: 'http://localhost:11434/v1',
      },
    );

    expect(calls).toBe(3);
    expect(report.cases[0]?.thinkAttempts).toBe(2);
    expect(report.cases[0]?.error).toMatch(/failed validation after 2 attempts/i);
    expect(report.cases[1]?.error).toBeNull();
    expect(report.cases[1]?.falseAlarm).toBe(false);
    expect(report.metrics.errors).toBe(1);
    expect(report.writtenFiles).toBeUndefined();
  });
});
