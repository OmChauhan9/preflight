import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBudgetedContext,
  collectGitDiff,
  DEFAULT_MAX_INPUT_TOKENS,
  estimateTokens,
  findAffectedTestsAndNeighbors,
  gatherContext,
  GatherGitError,
  loadWorkflowCommands,
  parseChangedFilesFromDiff,
  parseWorkflowYaml,
  resolveBaseRef,
  splitShellCommands,
  type BudgetContextParts,
  type GitExecFn,
} from '../src/gather/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tempDirs: string[] = [];

function createTempDir(prefix = 'preflight-gather-'): string {
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('workflow YAML parser & loader', () => {
  it('parses single-line, quoted, and multiline block scalar run commands with working-directory inheritance', () => {
    const yaml = [
      'name: Full CI',
      'defaults:',
      '  run:',
      '    working-directory: packages/default',
      '',
      'jobs:',
      '  js-checks:',
      '    runs-on: ubuntu-latest',
      '    defaults:',
      '      run:',
      '        working-directory: packages/web',
      '    strategy:',
      '      matrix:',
      '        working-directory: should-be-ignored',
      '    steps:',
      '      - name: Checkout',
      '        uses: actions/checkout@v4',
      '        with:',
      '          name: ignored-with-name',
      '          run: echo should-not-appear',
      '      - name: Single line',
      '        run: npm run lint # trailing comment',
      '      - name: Quoted hash preserved',
      '        run: \'pytest -k "test_a#1"\'',
      '      - run: |',
      '          # Run typecheck and tests',
      '          npm run typecheck',
      '',
      '          npx vitest run \\',
      '            test/unit \\',
      '            --reporter=verbose',
      '        name: Multiline block',
      '        working-directory: packages/core',
      '      - name: Folded scalar',
      '        run: >-',
      '          npx eslint',
      '          src',
      '  py-checks:',
      '    working-directory: services/api',
      '    steps:',
      '    - name: Compact list',
      '      run: |-',
      '        # Python checks',
      '        ruff check .',
      '        pytest tests',
    ].join('\n');

    const commands = parseWorkflowYaml('.github/workflows/full.yml', yaml);

    expect(commands).toEqual([
      {
        file: '.github/workflows/full.yml',
        job: 'js-checks',
        stepName: 'Single line',
        command: 'npm run lint',
        workingDirectory: 'packages/web',
      },
      {
        file: '.github/workflows/full.yml',
        job: 'js-checks',
        stepName: 'Quoted hash preserved',
        command: 'pytest -k "test_a#1"',
        workingDirectory: 'packages/web',
      },
      {
        file: '.github/workflows/full.yml',
        job: 'js-checks',
        stepName: 'Multiline block',
        command: 'npm run typecheck',
        workingDirectory: 'packages/core',
      },
      {
        file: '.github/workflows/full.yml',
        job: 'js-checks',
        stepName: 'Multiline block',
        command: 'npx vitest run test/unit --reporter=verbose',
        workingDirectory: 'packages/core',
      },
      {
        file: '.github/workflows/full.yml',
        job: 'js-checks',
        stepName: 'Folded scalar',
        command: 'npx eslint src',
        workingDirectory: 'packages/web',
      },
      {
        file: '.github/workflows/full.yml',
        job: 'py-checks',
        stepName: 'Compact list',
        command: 'ruff check .',
        workingDirectory: 'services/api',
      },
      {
        file: '.github/workflows/full.yml',
        job: 'py-checks',
        stepName: 'Compact list',
        command: 'pytest tests',
        workingDirectory: 'services/api',
      },
    ]);
  });

  it('splits shell commands skipping comments and joining line continuations', () => {
    const script = [
      '# header comment',
      '  ',
      'npm run lint',
      'pytest \\',
      '  tests/test_a.py \\',
      '  -q',
      '# mid comment \\',
      'echo done',
    ].join('\n');

    expect(splitShellCommands(script)).toEqual([
      'npm run lint',
      'pytest tests/test_a.py -q',
      'echo done',
    ]);
  });

  it('returns an empty array when .github/workflows directory is missing', () => {
    const dir = createTempDir();
    expect(loadWorkflowCommands(dir)).toEqual([]);
  });

  it('loads both .yml and .yaml files in deterministic order', () => {
    const dir = createTempDir();
    writeRepoFile(
      dir,
      '.github/workflows/b-lint.yaml',
      ['jobs:', '  lint:', '    steps:', '      - run: npm run lint'].join('\n'),
    );
    writeRepoFile(
      dir,
      '.github/workflows/a-test.yml',
      ['jobs:', '  test:', '    steps:', '      - run: npm test'].join('\n'),
    );
    writeRepoFile(dir, '.github/workflows/README.md', '# ignored');

    const commands = loadWorkflowCommands(dir);
    expect(commands).toEqual([
      { file: '.github/workflows/a-test.yml', job: 'test', command: 'npm test' },
      { file: '.github/workflows/b-lint.yaml', job: 'lint', command: 'npm run lint' },
    ]);
  });

  it('parses the real Preflight .github/workflows/ci.yml cleanly', () => {
    const commands = loadWorkflowCommands(REPO_ROOT);
    const ciCommands = commands.filter((cmd) => cmd.file === '.github/workflows/ci.yml');

    expect(ciCommands).toEqual([
      {
        file: '.github/workflows/ci.yml',
        job: 'verify',
        stepName: 'Install dependencies',
        command: 'npm ci',
      },
      {
        file: '.github/workflows/ci.yml',
        job: 'verify',
        stepName: 'Lint',
        command: 'npm run lint',
      },
      {
        file: '.github/workflows/ci.yml',
        job: 'verify',
        stepName: 'Typecheck',
        command: 'npm run typecheck',
      },
      {
        file: '.github/workflows/ci.yml',
        job: 'verify',
        stepName: 'Build',
        command: 'npm run build',
      },
      {
        file: '.github/workflows/ci.yml',
        job: 'verify',
        stepName: 'Test',
        command: 'npm test',
      },
    ]);
  });
});

describe('static import graph (JS/TS & Python)', () => {
  it('discovers direct and transitive affected tests and 1-hop neighbors in a JS/TS repo', () => {
    const dir = createTempDir();

    writeRepoFile(dir, 'src/util.ts', 'export const scale = (n: number) => n * 2;\n');
    writeRepoFile(
      dir,
      'src/core.ts',
      [
        "import { scale } from './util.js';",
        'export const compute = (x: number) => scale(x) + 1;',
      ].join('\n'),
    );
    writeRepoFile(
      dir,
      'src/service.ts',
      [
        "import { compute } from './core.js';",
        'export const runService = (n: number) => compute(n);',
      ].join('\n'),
    );
    writeRepoFile(
      dir,
      'src/handler.ts',
      [
        "import { runService } from './service';",
        'export const handle = (n: number) => runService(n);',
      ].join('\n'),
    );
    writeRepoFile(dir, 'src/barrel/index.ts', "export * from '../core.js';\n");
    writeRepoFile(dir, 'src/cjs-user.cjs', "const core = require('./core');\nmodule.exports = core;\n");
    writeRepoFile(
      dir,
      'src/dyn-user.ts',
      "export async function loadCore() { return import('./core.js'); }\n",
    );
    writeRepoFile(dir, 'src/unrelated.ts', 'export const noop = () => undefined;\n');
    writeRepoFile(
      dir,
      'test/handler.test.ts',
      [
        "import { handle } from '../src/handler.js';",
        'export const ok = handle(2);',
      ].join('\n'),
    );
    writeRepoFile(
      dir,
      'src/consumer.spec.ts',
      [
        "import { compute } from './barrel';",
        'export const ok = compute(3);',
      ].join('\n'),
    );
    writeRepoFile(
      dir,
      'test/unrelated.test.ts',
      [
        "// import { compute } from '../src/core.js';",
        "import { noop } from '../src/unrelated.js';",
        'export const ok = noop();',
      ].join('\n'),
    );

    // Ignored directories should never appear
    writeRepoFile(
      dir,
      'node_modules/pkg/index.test.ts',
      "import { compute } from '../../src/core.js';\nexport const x = compute(1);\n",
    );
    writeRepoFile(
      dir,
      'dist/core.test.js',
      "import { compute } from '../src/core.js';\nexport const x = compute(1);\n",
    );
    writeRepoFile(
      dir,
      'bench/cases/sample.test.ts',
      "import { compute } from '../../src/core.js';\nexport const x = compute(1);\n",
    );

    const { affectedTests, neighborContents } = findAffectedTestsAndNeighbors(dir, [
      'src/core.ts',
    ]);

    expect(affectedTests.map((t) => t.path)).toEqual([
      'src/consumer.spec.ts',
      'test/handler.test.ts',
    ]);
    expect(neighborContents.map((n) => n.path)).toEqual([
      'src/barrel/index.ts',
      'src/cjs-user.cjs',
      'src/dyn-user.ts',
      'src/service.ts',
      'src/util.ts',
    ]);
  });

  it('includes directly changed test files in affectedTests', () => {
    const dir = createTempDir();
    writeRepoFile(dir, 'test/direct.test.ts', 'export const direct = true;\n');

    const { affectedTests, neighborContents } = findAffectedTestsAndNeighbors(dir, [
      'test/direct.test.ts',
    ]);

    expect(affectedTests.map((t) => t.path)).toEqual(['test/direct.test.ts']);
    expect(neighborContents).toEqual([]);
  });

  it('discovers direct and transitive affected tests and 1-hop neighbors in a Python src-layout repo', () => {
    const dir = createTempDir();

    writeRepoFile(dir, 'src/myapp/__init__.py', '');
    writeRepoFile(dir, 'src/myapp/helpers.py', 'def clamp(x):\n    return max(0, x)\n');
    writeRepoFile(
      dir,
      'src/myapp/math_ops.py',
      'from .helpers import clamp\n\ndef add(a, b):\n    return clamp(a + b)\n',
    );
    writeRepoFile(
      dir,
      'src/myapp/calculator.py',
      [
        'from .math_ops import (',
        '    add,',
        ')',
        'def calc(a, b):',
        '    return add(a, b)',
      ].join('\n'),
    );
    writeRepoFile(
      dir,
      'src/myapp/api.py',
      'from myapp.calculator import calc\n\ndef handle():\n    return calc(1, 2)\n',
    );
    writeRepoFile(
      dir,
      'tests/calculator_test.py',
      'import myapp.calculator\n\ndef test_calc():\n    assert myapp.calculator.calc(1, 2) == 3\n',
    );
    writeRepoFile(
      dir,
      'tests/test_api.py',
      'from myapp.api import handle\n\ndef test_api():\n    assert handle() == 3\n',
    );
    writeRepoFile(
      dir,
      'tests/test_unrelated.py',
      '# from myapp.math_ops import add\nimport os\n\ndef test_ok():\n    assert os is not None\n',
    );
    writeRepoFile(
      dir,
      '.venv/lib/test_ignored.py',
      'from myapp.math_ops import add\n',
    );
    writeRepoFile(
      dir,
      '__pycache__/test_cached.py',
      'from myapp.math_ops import add\n',
    );

    const { affectedTests, neighborContents } = findAffectedTestsAndNeighbors(dir, [
      'src/myapp/math_ops.py',
    ]);

    expect(affectedTests.map((t) => t.path)).toEqual([
      'tests/calculator_test.py',
      'tests/test_api.py',
    ]);
    expect(neighborContents.map((n) => n.path)).toEqual([
      'src/myapp/calculator.py',
      'src/myapp/helpers.py',
    ]);
  });
});

describe('token estimation & 5-tier context budgeting', () => {
  it('estimates tokens with Math.ceil(text.length / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('drops lowest-priority tiers strictly in order 5 -> 4 -> 3 -> 2 -> 1 and always obeys maxInputTokens', () => {
    const parts: BudgetContextParts = {
      baseRef: 'main',
      diff: `diff --git a/src/a.ts b/src/a.ts\n+DIFF_SENTINEL ${'d'.repeat(600)}`,
      changedFiles: ['src/a.ts'],
      workflowCommands: Array.from({ length: 8 }, (_, idx) => ({
        file: '.github/workflows/ci.yml',
        job: 'verify',
        stepName: `Step ${idx + 1}`,
        command: `npm run check-${idx + 1} --flag=CI_CMD_SENTINEL_${idx + 1}`,
      })),
      affectedTests: [
        { path: 'test/a.test.ts', content: `TEST_SENTINEL\n${'t'.repeat(1600)}` },
      ],
      changedFileContents: [
        { path: 'src/a.ts', content: `CHANGED_SENTINEL\n${'c'.repeat(1600)}` },
      ],
      neighborContents: [
        { path: 'src/neighbor.ts', content: `NEIGHBOR_SENTINEL\n${'n'.repeat(1600)}` },
      ],
    };

    const full = buildBudgetedContext(parts, DEFAULT_MAX_INPUT_TOKENS);
    expect(full.truncatedSections).toEqual([]);
    expect(full.estimatedTokens).toBeLessThanOrEqual(DEFAULT_MAX_INPUT_TOKENS);
    expect(full.budgetedContext).toContain('DIFF_SENTINEL');
    expect(full.budgetedContext).toContain('CI_CMD_SENTINEL_1');
    expect(full.budgetedContext).toContain('TEST_SENTINEL');
    expect(full.budgetedContext).toContain('CHANGED_SENTINEL');
    expect(full.budgetedContext).toContain('NEIGHBOR_SENTINEL');

    const idxTier2 = full.budgetedContext.indexOf('\n\n## CI Workflow Commands');
    const idxTier3 = full.budgetedContext.indexOf('\n\n## Affected Tests');
    const idxTier4 = full.budgetedContext.indexOf('\n\n## Changed Files');
    const idxTier5 = full.budgetedContext.indexOf('\n\n## Neighbor Files');

    expect(idxTier2).toBeGreaterThan(0);
    expect(idxTier3).toBeGreaterThan(idxTier2);
    expect(idxTier4).toBeGreaterThan(idxTier3);
    expect(idxTier5).toBeGreaterThan(idxTier4);

    // Budget leaving room for tiers 1..4 only -> drops tier 5 (neighbors)
    const budget1to4 = Math.ceil(idxTier5 / 4) + 2;
    const res1to4 = buildBudgetedContext(parts, budget1to4);
    expect(res1to4.estimatedTokens).toBeLessThanOrEqual(budget1to4);
    expect(res1to4.truncatedSections).toEqual(['neighbors']);
    expect(res1to4.budgetedContext).toContain('DIFF_SENTINEL');
    expect(res1to4.budgetedContext).toContain('CI_CMD_SENTINEL_1');
    expect(res1to4.budgetedContext).toContain('TEST_SENTINEL');
    expect(res1to4.budgetedContext).toContain('CHANGED_SENTINEL');
    expect(res1to4.budgetedContext).not.toContain('NEIGHBOR_SENTINEL');

    // Budget leaving room for tiers 1..3 only -> drops tiers 5 & 4
    const budget1to3 = Math.ceil(idxTier4 / 4) + 2;
    const res1to3 = buildBudgetedContext(parts, budget1to3);
    expect(res1to3.estimatedTokens).toBeLessThanOrEqual(budget1to3);
    expect(res1to3.truncatedSections).toEqual(['neighbors', 'changed_files']);
    expect(res1to3.budgetedContext).toContain('DIFF_SENTINEL');
    expect(res1to3.budgetedContext).toContain('CI_CMD_SENTINEL_1');
    expect(res1to3.budgetedContext).toContain('TEST_SENTINEL');
    expect(res1to3.budgetedContext).not.toContain('CHANGED_SENTINEL');
    expect(res1to3.budgetedContext).not.toContain('NEIGHBOR_SENTINEL');

    // Budget leaving room for tiers 1..2 only -> drops tiers 5, 4, 3
    const budget1to2 = Math.ceil(idxTier3 / 4) + 2;
    const res1to2 = buildBudgetedContext(parts, budget1to2);
    expect(res1to2.estimatedTokens).toBeLessThanOrEqual(budget1to2);
    expect(res1to2.truncatedSections).toEqual([
      'neighbors',
      'changed_files',
      'affected_tests',
    ]);
    expect(res1to2.budgetedContext).toContain('DIFF_SENTINEL');
    expect(res1to2.budgetedContext).toContain('CI_CMD_SENTINEL_1');
    expect(res1to2.budgetedContext).not.toContain('TEST_SENTINEL');

    // Budget leaving room for tier 1 only -> drops tiers 5, 4, 3, 2
    const budget1Only = Math.ceil(idxTier2 / 4) + 2;
    const res1Only = buildBudgetedContext(parts, budget1Only);
    expect(res1Only.estimatedTokens).toBeLessThanOrEqual(budget1Only);
    expect(res1Only.truncatedSections).toEqual([
      'neighbors',
      'changed_files',
      'affected_tests',
      'ci_commands',
    ]);
    expect(res1Only.budgetedContext).toContain('DIFF_SENTINEL');
    expect(res1Only.budgetedContext).not.toContain('CI_CMD_SENTINEL_1');

    // Tiny budget -> truncates even tier 1 (git diff) and still respects maxInputTokens
    const tinyBudget = 40;
    const resTiny = buildBudgetedContext(parts, tinyBudget);
    expect(resTiny.estimatedTokens).toBeLessThanOrEqual(tinyBudget);
    expect(estimateTokens(resTiny.budgetedContext)).toBeLessThanOrEqual(tinyBudget);
    expect(resTiny.truncatedSections).toEqual([
      'neighbors',
      'changed_files',
      'affected_tests',
      'ci_commands',
      'git_diff',
    ]);
  });

  it('caps recentCiLog cleanly (retaining tail) and enforces default 20K budget on huge inputs', () => {
    const hugeParts: BudgetContextParts = {
      baseRef: 'main',
      diff: `diff --git a/src/big.ts b/src/big.ts\n+${'x'.repeat(20_000)}`,
      changedFiles: ['src/big.ts'],
      workflowCommands: [
        { file: '.github/workflows/ci.yml', job: 'verify', command: 'npm test' },
      ],
      affectedTests: [
        { path: 'test/big.test.ts', content: 'y'.repeat(40_000) },
      ],
      changedFileContents: [
        { path: 'src/big.ts', content: 'z'.repeat(40_000) },
      ],
      neighborContents: [
        { path: 'src/dep.ts', content: 'w'.repeat(40_000) },
      ],
      recentCiLog: `${'setup noise\n'.repeat(1200)}FAIL test/big.test.ts: AssertionError: expected 1 to be 2`,
    };

    const result = buildBudgetedContext(hugeParts);
    expect(result.estimatedTokens).toBeLessThanOrEqual(DEFAULT_MAX_INPUT_TOKENS);
    expect(estimateTokens(result.budgetedContext)).toBeLessThanOrEqual(
      DEFAULT_MAX_INPUT_TOKENS,
    );
    expect(result.budgetedContext).toContain('FAIL test/big.test.ts: AssertionError');
    expect(result.truncatedSections).toContain('recent_ci_log');
    expect(result.truncatedSections).toContain('neighbors');
  });
});

describe('git diff collection & gatherContext', () => {
  it('auto-detects baseRef fallback order and validates explicit baseRef with mocked gitExec', () => {
    const calls: string[][] = [];
    const mockGit: GitExecFn = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[2] === 'master') {
        return 'deadbeef\n';
      }
      throw new Error(`unknown ref: ${args[2] ?? ''}`);
    };

    const detected = resolveBaseRef('/repo', undefined, mockGit);
    expect(detected).toBe('master');
    expect(calls).toEqual([
      ['rev-parse', '--verify', 'origin/main'],
      ['rev-parse', '--verify', 'main'],
      ['rev-parse', '--verify', 'origin/master'],
      ['rev-parse', '--verify', 'master'],
    ]);

    expect(() => resolveBaseRef('/repo', 'bad-branch', mockGit)).toThrow(GatherGitError);
    expect(() => resolveBaseRef('/repo', '--exec=evil', mockGit)).toThrow(GatherGitError);
    expect(() => resolveBaseRef('/repo', '   ', mockGit)).toThrow(GatherGitError);
  });

  it('collects tracked diff and untracked files with mocked gitExec and deduplicates changedFiles', () => {
    const dir = createTempDir();
    writeRepoFile(dir, 'src/untracked.ts', 'export const added = 42;\n');

    const unifiedDiff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-export const v = 1;',
      '+export const v = 2;',
    ].join('\n');

    const mockGit: GitExecFn = (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/main') {
        return 'abc123\n';
      }
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return 'src/app.ts\n';
      }
      if (args[0] === 'diff' && args[1] === 'origin/main') {
        return unifiedDiff;
      }
      if (args[0] === 'ls-files') {
        return 'src/untracked.ts\nsrc/app.ts\n';
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    const result = collectGitDiff({ cwd: dir, gitExec: mockGit });

    expect(result.baseRef).toBe('origin/main');
    expect(result.changedFiles).toEqual(['src/app.ts', 'src/untracked.ts']);
    expect(result.diff).toContain('+export const v = 2;');
    expect(result.diff).toContain('+++ b/src/untracked.ts');
    expect(result.diff).toContain('+export const added = 42;');
  });

  it('parses modified, added, renamed, and deleted paths from unified diffs', () => {
    const diff = [
      'diff --git a/src/mod.ts b/src/mod.ts',
      '--- a/src/mod.ts',
      '+++ b/src/mod.ts',
      'diff --git a/src/old.ts b/src/new.ts',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'diff --git a/src/removed.ts b/src/removed.ts',
      'deleted file mode 100644',
      '--- a/src/removed.ts',
      '+++ /dev/null',
    ].join('\n');

    expect(parseChangedFilesFromDiff(diff)).toEqual([
      'src/mod.ts',
      'src/new.ts',
      'src/removed.ts',
    ]);
  });

  it('gathers end-to-end context from a real temp git repository and rejects invalid --base', () => {
    const repoDir = createTempDir('preflight-real-git-');

    runGit(repoDir, ['init']);
    runGit(repoDir, ['checkout', '-B', 'main']);

    writeRepoFile(
      repoDir,
      '.github/workflows/ci.yml',
      [
        'name: CI',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Lint',
        '        run: npm run lint',
        '      - name: Unit Tests',
        '        run: npm test',
      ].join('\n'),
    );
    writeRepoFile(repoDir, 'src/math.ts', 'export const add = (a: number, b: number) => a + b;\n');
    writeRepoFile(
      repoDir,
      'src/service.ts',
      "import { add } from './math.js';\nexport const sumTwo = (n: number) => add(n, 2);\n",
    );
    writeRepoFile(
      repoDir,
      'test/math.test.ts',
      "import { sumTwo } from '../src/service.js';\nexport const check = sumTwo(3);\n",
    );

    runGit(repoDir, ['add', '.']);
    runGit(repoDir, [
      '-c',
      'user.name=Preflight Test',
      '-c',
      'user.email=preflight@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'initial commit',
    ]);

    // Modify tracked file and add a new untracked file
    writeRepoFile(
      repoDir,
      'src/math.ts',
      'export const add = (a: number, b: number) => a + b + 1;\n',
    );
    writeRepoFile(repoDir, 'src/extra.ts', 'export const extra = true;\n');

    const gathered = gatherContext({ cwd: repoDir });

    expect(gathered.baseRef).toBe('main');
    expect(gathered.changedFiles).toEqual(['src/math.ts', 'src/extra.ts']);
    expect(gathered.diff).toContain('+export const add = (a: number, b: number) => a + b + 1;');
    expect(gathered.diff).toContain('+++ b/src/extra.ts');
    expect(gathered.diff).toContain('+export const extra = true;');
    expect(gathered.workflowCommands).toEqual([
      {
        file: '.github/workflows/ci.yml',
        job: 'test',
        stepName: 'Lint',
        command: 'npm run lint',
      },
      {
        file: '.github/workflows/ci.yml',
        job: 'test',
        stepName: 'Unit Tests',
        command: 'npm test',
      },
    ]);
    expect(gathered.affectedTests.map((t) => t.path)).toEqual(['test/math.test.ts']);
    expect(gathered.neighborContents.map((n) => n.path)).toEqual(['src/service.ts']);
    expect(gathered.changedFileContents.map((f) => f.path)).toEqual([
      'src/math.ts',
      'src/extra.ts',
    ]);
    expect(gathered.recentCiLog).toBeNull();
    expect(gathered.estimatedTokens).toBeGreaterThan(0);
    expect(gathered.estimatedTokens).toBeLessThanOrEqual(DEFAULT_MAX_INPUT_TOKENS);
    expect(gathered.truncatedSections).toEqual([]);
    expect(gathered.durationMs).toBeGreaterThanOrEqual(0);

    expect(() =>
      gatherContext({ cwd: repoDir, baseRef: 'nonexistent-base-branch-xyz' }),
    ).toThrow(GatherGitError);
  });
});
