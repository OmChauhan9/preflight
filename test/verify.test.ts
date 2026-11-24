import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkCommandAllowlist,
  executeCommand,
  extractCommandSignature,
  runVerify,
  tokenizeCommand,
  type ExecuteCommandOptions,
  type ExecuteCommandResult,
  type VerifyWorkflowCommand,
} from '../src/verify/index.js';

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

function quoteIfNeeded(value: string): string {
  return value.includes(' ') ? `"${value}"` : value;
}

describe('tokenizeCommand', () => {
  it('splits plain and quoted arguments without shell expansion', () => {
    expect(tokenizeCommand('npm test')).toEqual({
      ok: true,
      tokens: ['npm', 'test'],
    });
    expect(
      tokenizeCommand('pytest tests/test_auth.py -k "login or logout"'),
    ).toEqual({
      ok: true,
      tokens: ['pytest', 'tests/test_auth.py', '-k', 'login or logout'],
    });
    expect(
      tokenizeCommand("npx mocha --grep 'handles (a|b)' test/app.js"),
    ).toEqual({
      ok: true,
      tokens: ['npx', 'mocha', '--grep', 'handles (a|b)', 'test/app.js'],
    });
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \t  '],
    ['newline injection', 'npm test\necho pwn'],
    ['carriage return', 'npm test\recho pwn'],
    ['unclosed double quote', 'pytest -k "login'],
    ['unclosed single quote', "pytest -k 'login"],
    ['semicolon chaining', 'npm test; echo pwn'],
    ['logical AND chaining', 'npm test && whoami'],
    ['logical OR chaining', 'npm test || echo pwn'],
    ['pipe operator', 'pytest | tee out'],
    ['background operator', 'npm test &'],
    ['command substitution $()', 'pytest $(whoami)'],
    ['quoted command substitution $()', 'pytest "$(whoami)"'],
    ['backtick command substitution', 'pytest `id`'],
    ['quoted backtick substitution', 'pytest "`id`"'],
    ['output redirection', 'npm test > /tmp/x'],
    ['input redirection', 'npm test < /etc/passwd'],
    ['unquoted variable expansion', 'pytest $HOME'],
    ['braced variable expansion', 'pytest "${IFS}pwn"'],
    ['double-quoted variable expansion', 'pytest "$HOME"'],
    ['subshell parens', '(npm test)'],
    ['unquoted tilde expansion', 'pytest ~/secret'],
    ['unquoted backslash escape', 'npm test \\; whoami'],
  ])('rejects %s: %s', (_label, command) => {
    const result = tokenizeCommand(command);
    expect(result.ok).toBe(false);
  });
});

describe('extractCommandSignature', () => {
  it('normalizes JS/TS and Python runner and subcommand shapes', () => {
    expect(extractCommandSignature(['npm', 'test'])).toEqual(['npm', 'test']);
    expect(extractCommandSignature(['npm', 'run', 'lint'])).toEqual([
      'npm',
      'run',
      'lint',
    ]);
    expect(extractCommandSignature(['pnpm', 'run', 'test'])).toEqual([
      'pnpm',
      'test',
    ]);
    expect(extractCommandSignature(['pnpm', 'test'])).toEqual(['pnpm', 'test']);
    expect(extractCommandSignature(['yarn', 'run', 'lint'])).toEqual([
      'yarn',
      'lint',
    ]);
    expect(extractCommandSignature(['yarn', 'lint'])).toEqual(['yarn', 'lint']);
    expect(
      extractCommandSignature(['npx', 'vitest', 'run', 'test/cli.test.ts']),
    ).toEqual(['npx', 'vitest', 'run']);
    expect(extractCommandSignature(['npx', 'eslint', 'src/index.ts'])).toEqual([
      'npx',
      'eslint',
    ]);
    expect(extractCommandSignature(['npx', 'tsc', '--noEmit'])).toEqual([
      'npx',
      'tsc',
    ]);
    expect(
      extractCommandSignature(['python', '-m', 'pytest', 'tests/test_a.py']),
    ).toEqual(['python', '-m', 'pytest']);
    expect(
      extractCommandSignature(['python3', '-m', 'pytest', 'tests/test_a.py']),
    ).toEqual(['python', '-m', 'pytest']);
    expect(
      extractCommandSignature(['uv', 'run', 'pytest', 'tests/test_a.py']),
    ).toEqual(['uv', 'run', 'pytest']);
    expect(
      extractCommandSignature(['uv', 'run', 'ruff', 'check', 'src/app.py']),
    ).toEqual(['uv', 'run', 'ruff', 'check']);
    expect(extractCommandSignature(['ruff', 'check', 'src/app.py'])).toEqual([
      'ruff',
      'check',
    ]);
    expect(extractCommandSignature(['ruff', 'format', '--check'])).toEqual([
      'ruff',
      'format',
    ]);
    expect(extractCommandSignature(['pytest', 'tests/test_auth.py'])).toEqual([
      'pytest',
    ]);
    expect(extractCommandSignature(['mypy', 'src/app.py'])).toEqual(['mypy']);
    expect(extractCommandSignature(['tox', 'run', '-e', 'py312'])).toEqual([
      'tox',
      'run',
    ]);
  });
});

describe('checkCommandAllowlist', () => {
  const standardWorkflows: VerifyWorkflowCommand[] = [
    wf('npm test'),
    wf('npm run lint'),
    wf('npx vitest run'),
    wf('pytest'),
    wf('ruff check .'),
    wf('pnpm run typecheck'),
    wf('CI=true yarn run test'),
    wf('uv run pytest'),
    wf('python -m pytest'),
  ];

  it('fails closed when workflowCommands is empty', () => {
    const decision = checkCommandAllowlist('npm test', []);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('No CI workflow commands found');
    }
  });

  it.each([
    ['npm test', 'npm', ['test']],
    ['npm run lint', 'npm', ['run', 'lint']],
    ['pytest', 'pytest', []],
    ['npx vitest run', 'npx', ['vitest', 'run']],
    ['yarn run test', 'yarn', ['run', 'test']],
  ])('allows exact CI workflow command: %s', (command, binary, args) => {
    const decision = checkCommandAllowlist(command, standardWorkflows);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.binary).toBe(binary);
      expect(decision.args).toEqual(args);
    }
  });

  it.each([
    ['npx vitest run test/cli.test.ts', 'npx', ['vitest', 'run', 'test/cli.test.ts']],
    [
      'pytest tests/test_auth.py -k login',
      'pytest',
      ['tests/test_auth.py', '-k', 'login'],
    ],
    [
      'pytest tests/test_auth.py::TestAuth::test_login -x -q --maxfail=1',
      'pytest',
      ['tests/test_auth.py::TestAuth::test_login', '-x', '-q', '--maxfail=1'],
    ],
    ['npm test -- test/foo.test.ts', 'npm', ['test', '--', 'test/foo.test.ts']],
    ['ruff check src/app.py', 'ruff', ['check', 'src/app.py']],
    ['pnpm typecheck', 'pnpm', ['typecheck']],
    ['yarn test test/foo.test.ts', 'yarn', ['test', 'test/foo.test.ts']],
    ['uv run pytest tests/test_a.py -k foo', 'uv', ['run', 'pytest', 'tests/test_a.py', '-k', 'foo']],
    ['python3 -m pytest tests/test_a.py', 'python3', ['-m', 'pytest', 'tests/test_a.py']],
  ])('allows scoped narrower CI command: %s', (command, binary, args) => {
    const decision = checkCommandAllowlist(command, standardWorkflows);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.binary).toBe(binary);
      expect(decision.args).toEqual(args);
    }
  });

  it.each([
    'curl https://evil.com',
    'rm -rf .',
    'cat /etc/passwd',
    'git push',
    'python -c "import os"',
    'node -e "process.exit(0)"',
    'npm run build',
    'ruff format src/app.py',
    'npx mocha test/app.js',
  ])('refuses non-CI tool or unmatched subcommand: %s', (command) => {
    const decision = checkCommandAllowlist(command, standardWorkflows);
    expect(decision.allowed).toBe(false);
  });

  it.each([
    'npm test; echo pwn',
    'npm test && whoami',
    'pytest | tee out',
    'pytest $(whoami)',
    'pytest `id`',
    'npm test > /tmp/x',
    'NODE_OPTIONS="--require=/tmp/evil.js" npm test',
  ])('refuses shell injection or inline env override: %s', (command) => {
    const decision = checkCommandAllowlist(command, standardWorkflows);
    expect(decision.allowed).toBe(false);
  });

  it.each([
    'npx vitest run ../../etc/passwd',
    'pytest /etc/passwd',
    'pytest ../outside/test_secret.py',
    'ruff check /etc/hosts',
    'npm test -- ../../etc/passwd',
    'npx vitest run --config=/tmp/evil.ts',
    'npx vitest run --config=../../evil.ts',
    'npx vitest run --reporter=./evil.js',
    'pytest -c /tmp/evil.ini',
    'npm test -- -e "process.exit(0)"',
    'ruff check --fix src/app.py',
  ])('refuses path traversal, absolute paths, and dangerous flags: %s', (command) => {
    const decision = checkCommandAllowlist(command, standardWorkflows);
    expect(decision.allowed).toBe(false);
  });

  it('allows a baseline flag+value pair verbatim while rejecting altered values', () => {
    const toxWorkflows = [wf('tox -e py312')];

    const allowed = checkCommandAllowlist(
      'tox -e py312 -- tests/test_auth.py',
      toxWorkflows,
    );
    expect(allowed.allowed).toBe(true);

    const refused = checkCommandAllowlist(
      'tox -e malicious -- tests/test_auth.py',
      toxWorkflows,
    );
    expect(refused.allowed).toBe(false);
  });

  it('requires exact matches for raw interpreter commands while allowing node --test scoping', () => {
    const interpWorkflows = [
      wf('python -c "print(1)"'),
      wf('node scripts/check.mjs'),
      wf('node --test'),
    ];

    expect(
      checkCommandAllowlist('python -c "print(1)"', interpWorkflows).allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('python -c "import os"', interpWorkflows).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('node scripts/check.mjs', interpWorkflows).allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('node scripts/evil.mjs', interpWorkflows).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('node --test test/foo.test.js', interpWorkflows)
        .allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('node -e "process.exit(0)"', interpWorkflows)
        .allowed,
    ).toBe(false);
  });

  it('enforces exact match for path-qualified python scripts while still scoping path-qualified python -m tools', () => {
    const venvWorkflows = [
      wf('.venv/bin/python script.py'),
      wf('.venv/bin/python -m pytest'),
    ];

    expect(
      checkCommandAllowlist('.venv/bin/python script.py', venvWorkflows)
        .allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist(
        '.venv/bin/python script.py --extra-arg',
        venvWorkflows,
      ).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('.venv/bin/python evil.py', venvWorkflows).allowed,
    ).toBe(false);

    const scopedPytest = checkCommandAllowlist(
      '.venv/bin/python -m pytest tests/test_a.py',
      venvWorkflows,
    );
    expect(scopedPytest.allowed).toBe(true);
    if (scopedPytest.allowed) {
      expect(scopedPytest.binary).toBe('.venv/bin/python');
      expect(scopedPytest.args).toEqual(['-m', 'pytest', 'tests/test_a.py']);
    }
  });
});

describe('runVerify (unit tests with mocked spawnCommand)', () => {
  const workflows: VerifyWorkflowCommand[] = [
    wf('npm test'),
    wf('npm run lint'),
    wf('npx vitest run', { workingDirectory: 'packages/core' }),
    wf('pytest', { workingDirectory: '../escape' }),
  ];

  it('returns "these checks passed" when all executed allowlisted checks exit 0', async () => {
    const calls: Array<{
      binary: string;
      args: readonly string[];
      options: ExecuteCommandOptions;
    }> = [];
    const spawnCommand = vi.fn(
      async (
        binary: string,
        args: readonly string[],
        options: ExecuteCommandOptions,
      ): Promise<ExecuteCommandResult> => {
        calls.push({ binary, args, options });
        return {
          status: 'passed',
          exitCode: 0,
          durationMs: 12,
          stdout: 'ok',
          stderr: '',
        };
      },
    );

    const result = await runVerify(
      ['npm run lint', 'npm test -- test/cli.test.ts', 'curl https://evil.com'],
      workflows,
      { cwd: '/repo', spawnCommand },
    );

    expect(spawnCommand).toHaveBeenCalledTimes(2);
    expect(calls[0]?.binary).toBe('npm');
    expect(calls[0]?.args).toEqual(['run', 'lint']);
    expect(calls[1]?.args).toEqual(['test', '--', 'test/cli.test.ts']);

    expect(result.verdict).toBe('passed');
    expect(result.verdictMessage).toBe('these checks passed');
    expect(result.verdictMessage.toLowerCase()).not.toContain('ci will pass');
    expect(result.refusedCommands).toHaveLength(1);
    expect(result.refusedCommands[0]?.command).toBe('curl https://evil.com');
    expect(result.results.map((r) => r.status)).toEqual([
      'passed',
      'passed',
      'refused',
    ]);
  });

  it('returns "these checks failed" when any executed check exits non-zero or times out', async () => {
    let callIndex = 0;
    const spawnCommand = vi.fn(
      async (): Promise<ExecuteCommandResult> => {
        callIndex += 1;
        if (callIndex === 1) {
          return {
            status: 'passed',
            exitCode: 0,
            durationMs: 10,
            stdout: 'lint ok',
            stderr: '',
          };
        }
        return {
          status: 'failed',
          exitCode: 1,
          durationMs: 25,
          stdout: '',
          stderr: '1 test failed',
        };
      },
    );

    const result = await runVerify(
      ['npm run lint', 'npm test'],
      workflows,
      { cwd: '/repo', spawnCommand },
    );

    expect(result.verdict).toBe('failed');
    expect(result.verdictMessage).toBe('these checks failed');
    expect(result.verdictMessage.toLowerCase()).not.toContain('ci will pass');
    expect(result.results[0]?.status).toBe('passed');
    expect(result.results[1]?.status).toBe('failed');
    expect(result.results[1]?.exitCode).toBe(1);
  });

  it('returns "no allowlisted checks were executed" when all commands are refused, workflows empty, or candidates empty', async () => {
    const spawnCommand = vi.fn(
      async (
        _binary: string,
        _args: readonly string[],
        _options: ExecuteCommandOptions,
      ): Promise<ExecuteCommandResult> => {
        throw new Error('spawnCommand must not be invoked for refused commands');
      },
    );

    const refusedOnly = await runVerify(
      ['rm -rf .', 'npm test && whoami'],
      workflows,
      { cwd: '/repo', spawnCommand },
    );
    expect(spawnCommand).not.toHaveBeenCalled();
    expect(refusedOnly.verdict).toBe('no_checks_run');
    expect(refusedOnly.verdictMessage).toBe(
      'no allowlisted checks were executed',
    );
    expect(refusedOnly.refusedCommands).toHaveLength(2);
    expect(refusedOnly.results.every((r) => r.status === 'refused')).toBe(true);

    const noWorkflows = await runVerify(['npm test'], [], {
      cwd: '/repo',
      spawnCommand,
    });
    expect(spawnCommand).not.toHaveBeenCalled();
    expect(noWorkflows.verdict).toBe('no_checks_run');
    expect(noWorkflows.verdictMessage).toBe(
      'no allowlisted checks were executed',
    );
    expect(noWorkflows.refusedCommands).toHaveLength(1);

    const emptyCandidates = await runVerify([], workflows, {
      cwd: '/repo',
      spawnCommand,
    });
    expect(emptyCandidates.verdict).toBe('no_checks_run');
    expect(emptyCandidates.verdictMessage).toBe(
      'no allowlisted checks were executed',
    );
    expect(emptyCandidates.results).toEqual([]);
  });

  it('respects valid repo-internal workingDirectory and refuses escaping workingDirectory', async () => {
    const seenCwds: string[] = [];
    const spawnCommand = vi.fn(
      async (
        _binary: string,
        _args: readonly string[],
        options: ExecuteCommandOptions,
      ): Promise<ExecuteCommandResult> => {
        seenCwds.push(options.cwd);
        return {
          status: 'passed',
          exitCode: 0,
          durationMs: 5,
          stdout: '',
          stderr: '',
        };
      },
    );

    const result = await runVerify(
      ['npx vitest run test/a.test.ts', 'pytest'],
      workflows,
      { cwd: '/repo', spawnCommand },
    );

    expect(spawnCommand).toHaveBeenCalledTimes(1);
    expect(seenCwds).toEqual([resolve('/repo', 'packages/core')]);
    expect(result.results[0]?.status).toBe('passed');
    expect(result.results[1]?.status).toBe('refused');
    expect(result.refusedCommands).toHaveLength(1);
    expect(result.refusedCommands[0]?.command).toBe('pytest');
  });
});

describe('executeCommand & runVerify (real subprocess execution)', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-verify-'));
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

  it('executes passing, failing, and timed-out commands via spawn(shell: false)', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'pass.mjs'),
      "process.stdout.write('check passed output\\n'); process.exit(0);\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'fail.mjs'),
      "process.stderr.write('assertion error\\n'); process.exit(2);\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'hang.mjs'),
      'setTimeout(() => {}, 10_000);\n',
      'utf8',
    );

    const nodeBin = quoteIfNeeded(process.execPath);
    const passCmd = `${nodeBin} pass.mjs`;
    const failCmd = `${nodeBin} fail.mjs`;
    const hangCmd = `${nodeBin} hang.mjs`;

    const workflowFixtures: VerifyWorkflowCommand[] = [
      wf(passCmd),
      wf(failCmd),
      wf(hangCmd),
    ];

    // 1. Passing subprocess
    const passResult = await runVerify([passCmd], workflowFixtures, {
      cwd: dir,
      timeoutMs: 5_000,
    });
    expect(passResult.verdict).toBe('passed');
    expect(passResult.verdictMessage).toBe('these checks passed');
    expect(passResult.results[0]?.status).toBe('passed');
    expect(passResult.results[0]?.exitCode).toBe(0);
    expect(passResult.results[0]?.stdout).toContain('check passed output');

    // 2. Failing subprocess (non-zero exit code)
    const failResult = await runVerify([failCmd], workflowFixtures, {
      cwd: dir,
      timeoutMs: 5_000,
    });
    expect(failResult.verdict).toBe('failed');
    expect(failResult.verdictMessage).toBe('these checks failed');
    expect(failResult.results[0]?.status).toBe('failed');
    expect(failResult.results[0]?.exitCode).toBe(2);
    expect(failResult.results[0]?.stderr).toContain('assertion error');

    // 3. Timed-out subprocess
    const timeoutResult = await runVerify([hangCmd], workflowFixtures, {
      cwd: dir,
      timeoutMs: 150,
    });
    expect(timeoutResult.verdict).toBe('failed');
    expect(timeoutResult.verdictMessage).toBe('these checks failed');
    expect(timeoutResult.results[0]?.status).toBe('timed_out');
    expect(timeoutResult.results[0]?.exitCode).toBeNull();
  });

  it('caps stdout/stderr to maxOutputBytes keeping the tail and handles ENOENT cleanly', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'noisy.mjs'),
      "process.stdout.write('START_' + 'x'.repeat(500) + '_TAIL_SUMMARY');\n",
      'utf8',
    );

    const noisyResult = await executeCommand(process.execPath, ['noisy.mjs'], {
      cwd: dir,
      timeoutMs: 5_000,
      maxOutputBytes: 64,
    });
    expect(noisyResult.status).toBe('passed');
    expect(noisyResult.exitCode).toBe(0);
    expect(Buffer.byteLength(noisyResult.stdout, 'utf8')).toBeLessThanOrEqual(64);
    expect(noisyResult.stdout).toContain('_TAIL_SUMMARY');
    expect(noisyResult.stdout).not.toContain('START_');

    const missingResult = await executeCommand(
      'preflight-definitely-missing-binary-xyz-999',
      [],
      {
        cwd: dir,
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
      },
    );
    expect(missingResult.status).toBe('failed');
    expect(missingResult.exitCode).toBeNull();
    expect(missingResult.stderr.length).toBeGreaterThan(0);
  });
});
