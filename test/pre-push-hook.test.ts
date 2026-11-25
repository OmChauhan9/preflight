import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installPrePushHook,
  PREFLIGHT_HOOK_MARKER,
  PrePushHookError,
  renderPrePushHookScript,
  resolveGitHooksDir,
} from '../src/hooks/index.js';

const createdTempDirs: string[] = [];

function createTempDir(prefix = 'preflight-hook-test-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('renderPrePushHookScript', () => {
  it('renders a POSIX sh script checking PATH and ./node_modules/.bin/preflight with npm link and bypass hints', () => {
    const script = renderPrePushHookScript();

    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(PREFLIGHT_HOOK_MARKER);
    expect(script).toContain('command -v preflight');
    expect(script).toContain('preflight check');
    expect(script).toContain('[ -x ./node_modules/.bin/preflight ]');
    expect(script).toContain('./node_modules/.bin/preflight check');
    expect(script).toContain("'npm link' from a local Preflight checkout");
    expect(script).toContain('git push --no-verify');
    expect(script).toContain('exit $?');
    expect(script).toContain('exit 1');
    expect(script).not.toContain('npm install -D preflight');
    expect(script).not.toContain('npx --no-install');
    expect(script).not.toContain('-eq 127');
    expect(script.endsWith('\n')).toBe(true);
  });

  it('prints actionable missing-CLI diagnostic when preflight is absent and executes local node_modules binary when present', () => {
    const repoDir = createTempDir('preflight-hook-exec-');
    const emptyBinDir = createTempDir('preflight-empty-bin-');
    mkdirSync(path.join(repoDir, '.git'));
    const { hookPath } = installPrePushHook(repoDir);

    // 1. Neither PATH nor ./node_modules/.bin/preflight has preflight -> exits 1 with diagnostic + bypass hint.
    let missingErr: unknown;
    try {
      execFileSync('/bin/sh', [hookPath], {
        cwd: repoDir,
        env: { PATH: emptyBinDir },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      missingErr = error;
    }

    expect(missingErr).toBeDefined();
    const failedExec = missingErr as { status?: number; stderr?: string };
    expect(failedExec.status).toBe(1);
    expect(failedExec.stderr).toContain('CLI not found');
    expect(failedExec.stderr).toContain("'npm link' from a local Preflight checkout");
    expect(failedExec.stderr).toContain('git push --no-verify');

    // 2. Executable ./node_modules/.bin/preflight present -> invoked with "check" and exit code propagated.
    const localBinDir = path.join(repoDir, 'node_modules', '.bin');
    mkdirSync(localBinDir, { recursive: true });
    const localPreflight = path.join(localBinDir, 'preflight');
    writeFileSync(
      localPreflight,
      '#!/bin/sh\necho "local-preflight:$*"\nexit 0\n',
      { encoding: 'utf8', mode: 0o755 },
    );

    const stdout = execFileSync('/bin/sh', [hookPath], {
      cwd: repoDir,
      env: { PATH: emptyBinDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(stdout.trim()).toBe('local-preflight:check');

    // 3. Local binary exits 1 (failed checks) -> exits 1 without spurious "CLI not found" diagnostic.
    writeFileSync(
      localPreflight,
      '#!/bin/sh\necho "checks failed" >&2\nexit 1\n',
      { encoding: 'utf8', mode: 0o755 },
    );
    let checkFailErr: unknown;
    try {
      execFileSync('/bin/sh', [hookPath], {
        cwd: repoDir,
        env: { PATH: emptyBinDir },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      checkFailErr = error;
    }
    const failedCheck = checkFailErr as { status?: number; stderr?: string };
    expect(failedCheck.status).toBe(1);
    expect(failedCheck.stderr).toContain('checks failed');
    expect(failedCheck.stderr).not.toContain('CLI not found');
  });
});

describe('installPrePushHook', () => {
  it('installs the pre-push hook into a standard .git directory with mode 0o755', () => {
    const repoDir = createTempDir();
    mkdirSync(path.join(repoDir, '.git'));

    const result = installPrePushHook(repoDir);
    const expectedHookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');

    expect(result).toEqual({
      hookPath: expectedHookPath,
      status: 'installed',
    });
    expect(readFileSync(expectedHookPath, 'utf8')).toBe(
      renderPrePushHookScript(),
    );
    expect(statSync(expectedHookPath).mode & 0o777).toBe(0o755);
  });

  it('is idempotent on re-run and ensures executable mode 0o755', () => {
    const repoDir = createTempDir();
    mkdirSync(path.join(repoDir, '.git'));

    const first = installPrePushHook(repoDir);
    expect(first.status).toBe('installed');

    // Simulate permissions drifting to non-executable; re-run should restore 0o755.
    chmodSync(first.hookPath, 0o644);

    const second = installPrePushHook(repoDir);
    expect(second).toEqual({
      hookPath: first.hookPath,
      status: 'already_installed',
    });
    expect(statSync(second.hookPath).mode & 0o777).toBe(0o755);
  });

  it('updates an outdated preflight-managed hook automatically', () => {
    const repoDir = createTempDir();
    const hooksDir = path.join(repoDir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-push');
    writeFileSync(
      hookPath,
      `#!/bin/sh\n${PREFLIGHT_HOOK_MARKER}\necho "old version"\n`,
      { encoding: 'utf8', mode: 0o644 },
    );

    const result = installPrePushHook(repoDir);

    expect(result).toEqual({
      hookPath,
      status: 'updated',
    });
    expect(readFileSync(hookPath, 'utf8')).toBe(renderPrePushHookScript());
    expect(statSync(hookPath).mode & 0o777).toBe(0o755);
  });

  it('refuses to overwrite an existing custom hook without --force', () => {
    const repoDir = createTempDir();
    const hooksDir = path.join(repoDir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-push');
    const customHook = '#!/bin/sh\necho "custom user hook"\n';
    writeFileSync(hookPath, customHook, { encoding: 'utf8', mode: 0o755 });

    let caughtError: unknown;
    try {
      installPrePushHook(repoDir);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(PrePushHookError);
    expect((caughtError as PrePushHookError).code).toBe('EXISTING_CUSTOM_HOOK');
    expect((caughtError as Error).message).toContain('--force');
    expect(readFileSync(hookPath, 'utf8')).toBe(customHook);
  });

  it('overwrites an existing custom hook when force is true', () => {
    const repoDir = createTempDir();
    const hooksDir = path.join(repoDir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-push');
    writeFileSync(hookPath, '#!/bin/sh\necho "custom user hook"\n', {
      encoding: 'utf8',
      mode: 0o644,
    });

    const result = installPrePushHook(repoDir, { force: true });

    expect(result).toEqual({
      hookPath,
      status: 'updated',
    });
    expect(readFileSync(hookPath, 'utf8')).toBe(renderPrePushHookScript());
    expect(statSync(hookPath).mode & 0o777).toBe(0o755);
  });

  it('supports .git gitdir pointer files (relative path)', () => {
    const baseDir = createTempDir();
    const actualGitDir = path.join(baseDir, 'actual-git-dir');
    const worktreeDir = path.join(baseDir, 'linked-worktree');
    mkdirSync(actualGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      path.join(worktreeDir, '.git'),
      'gitdir: ../actual-git-dir\n',
      'utf8',
    );

    const result = installPrePushHook(worktreeDir);
    const expectedHookPath = path.join(actualGitDir, 'hooks', 'pre-push');

    expect(result).toEqual({
      hookPath: expectedHookPath,
      status: 'installed',
    });
    expect(readFileSync(expectedHookPath, 'utf8')).toBe(
      renderPrePushHookScript(),
    );
    expect(statSync(expectedHookPath).mode & 0o777).toBe(0o755);
  });

  it('resolves shared hooks directory via commondir in linked git worktrees', () => {
    const baseDir = createTempDir();
    const mainGitDir = path.join(baseDir, 'main-repo', '.git');
    const wtGitDir = path.join(mainGitDir, 'worktrees', 'feature-branch');
    const worktreeDir = path.join(baseDir, 'wt-feature');
    mkdirSync(wtGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8');
    writeFileSync(
      path.join(worktreeDir, '.git'),
      `gitdir: ${wtGitDir}\n`,
      'utf8',
    );

    expect(resolveGitHooksDir(worktreeDir)).toBe(path.join(mainGitDir, 'hooks'));

    const result = installPrePushHook(worktreeDir);
    const expectedHookPath = path.join(mainGitDir, 'hooks', 'pre-push');

    expect(result).toEqual({
      hookPath: expectedHookPath,
      status: 'installed',
    });
    expect(statSync(expectedHookPath).mode & 0o777).toBe(0o755);
  });

  it('throws a clear error for non-git directories and invalid .git pointer files', () => {
    const nonGitDir = createTempDir();

    expect(() => installPrePushHook(nonGitDir)).toThrow(PrePushHookError);
    expect(() => installPrePushHook(nonGitDir)).toThrow(/Not a git repository/i);

    const invalidPointerDir = createTempDir();
    writeFileSync(path.join(invalidPointerDir, '.git'), 'not-a-gitdir\n', 'utf8');
    expect(() => installPrePushHook(invalidPointerDir)).toThrow(
      /expected a "gitdir: <path>" entry/i,
    );

    const missingTargetDir = createTempDir();
    writeFileSync(
      path.join(missingTargetDir, '.git'),
      'gitdir: ./does-not-exist\n',
      'utf8',
    );
    expect(() => installPrePushHook(missingTargetDir)).toThrow(
      /does not exist/i,
    );
  });
});
