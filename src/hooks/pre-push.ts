import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

export const PREFLIGHT_HOOK_MARKER = '# preflight-managed-hook';

const HOOK_FILE_MODE = 0o755;

export type PrePushHookErrorCode =
  | 'NOT_A_GIT_REPO'
  | 'INVALID_GITDIR'
  | 'EXISTING_CUSTOM_HOOK'
  | 'INVALID_HOOK_PATH';

export class PrePushHookError extends Error {
  readonly code: PrePushHookErrorCode;

  constructor(code: PrePushHookErrorCode, message: string) {
    super(message);
    this.name = 'PrePushHookError';
    this.code = code;
  }
}

export interface InstallPrePushHookOptions {
  force?: boolean;
}

export type PrePushHookInstallStatus =
  | 'installed'
  | 'updated'
  | 'already_installed';

export interface InstallPrePushHookResult {
  hookPath: string;
  status: PrePushHookInstallStatus;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function isManagedHookContent(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => line.trim() === PREFLIGHT_HOOK_MARKER);
}

/**
 * Renders the POSIX `#!/bin/sh` git `pre-push` hook script managed by Preflight.
 */
export function renderPrePushHookScript(): string {
  return [
    '#!/bin/sh',
    PREFLIGHT_HOOK_MARKER,
    '# Managed by Preflight (`preflight init --hook`).',
    '# Runs scoped CI pre-checks before pushing commits.',
    '# To bypass this hook when needed, run: git push --no-verify',
    '',
    'if command -v preflight >/dev/null 2>&1; then',
    '  preflight check',
    '  exit $?',
    'fi',
    '',
    'if [ -x ./node_modules/.bin/preflight ]; then',
    '  ./node_modules/.bin/preflight check',
    '  exit $?',
    'fi',
    '',
    'echo "preflight: CLI not found on PATH or in ./node_modules/.bin/preflight." >&2',
    'echo "Hint: link preflight using \'npm link\' from a local Preflight checkout, or bypass with \'git push --no-verify\'." >&2',
    'exit 1',
    '',
  ].join('\n');
}

/**
 * Resolves the `.git/hooks` directory for a repository root, supporting both standard `.git`
 * directories and `.git` pointer files (`gitdir:`) used by worktrees and submodules.
 */
export function resolveGitHooksDir(repoRoot: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const dotGitPath = path.join(resolvedRoot, '.git');

  let dotGitStat: Stats;
  try {
    dotGitStat = statSync(dotGitPath);
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new PrePushHookError(
        'NOT_A_GIT_REPO',
        `Not a git repository: "${resolvedRoot}" does not contain a .git directory or file.`,
      );
    }
    throw error;
  }

  if (dotGitStat.isDirectory()) {
    return path.join(dotGitPath, 'hooks');
  }

  if (dotGitStat.isFile()) {
    const content = readFileSync(dotGitPath, 'utf8');
    const gitDirMatch = /^gitdir:\s*(.+)$/im.exec(content);
    const rawGitDir = gitDirMatch?.[1]?.trim();

    if (!rawGitDir) {
      throw new PrePushHookError(
        'INVALID_GITDIR',
        `Invalid .git file at "${dotGitPath}": expected a "gitdir: <path>" entry.`,
      );
    }

    const resolvedGitDir = path.resolve(resolvedRoot, rawGitDir);

    let gitDirStat: Stats;
    try {
      gitDirStat = statSync(resolvedGitDir);
    } catch (error) {
      const code = getErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new PrePushHookError(
          'INVALID_GITDIR',
          `Git directory referenced by "${dotGitPath}" does not exist: "${resolvedGitDir}".`,
        );
      }
      throw error;
    }

    if (!gitDirStat.isDirectory()) {
      throw new PrePushHookError(
        'INVALID_GITDIR',
        `Git directory referenced by "${dotGitPath}" is not a directory: "${resolvedGitDir}".`,
      );
    }

    // Linked git worktrees store a `commondir` pointer to the shared git directory where hooks run.
    const commonDirPointer = path.join(resolvedGitDir, 'commondir');
    try {
      const commonPointerStat = statSync(commonDirPointer);
      if (commonPointerStat.isFile()) {
        const rawCommonDir = readFileSync(commonDirPointer, 'utf8').trim();
        if (rawCommonDir.length > 0) {
          const resolvedCommonDir = path.resolve(resolvedGitDir, rawCommonDir);
          if (statSync(resolvedCommonDir).isDirectory()) {
            return path.join(resolvedCommonDir, 'hooks');
          }
        }
      }
    } catch (error) {
      const code = getErrorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
    }

    return path.join(resolvedGitDir, 'hooks');
  }

  throw new PrePushHookError(
    'NOT_A_GIT_REPO',
    `Unsupported .git entry at "${dotGitPath}": expected a directory or gitdir file.`,
  );
}

/**
 * Installs or updates the Preflight-managed git `pre-push` hook inside `repoRoot`.
 * Refuses to overwrite a non-Preflight custom hook unless `options.force` is true.
 */
export function installPrePushHook(
  repoRoot: string,
  options?: InstallPrePushHookOptions,
): InstallPrePushHookResult {
  const hooksDir = resolveGitHooksDir(repoRoot);
  mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, 'pre-push');
  const script = renderPrePushHookScript();

  let existingStat: Stats | null = null;
  try {
    existingStat = statSync(hookPath);
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  if (existingStat !== null) {
    if (!existingStat.isFile()) {
      throw new PrePushHookError(
        'INVALID_HOOK_PATH',
        `Cannot install pre-push hook: "${hookPath}" exists and is not a regular file.`,
      );
    }

    const existingContent = readFileSync(hookPath, 'utf8');
    if (isManagedHookContent(existingContent)) {
      if (existingContent === script) {
        chmodSync(hookPath, HOOK_FILE_MODE);
        return { hookPath, status: 'already_installed' };
      }

      writeFileSync(hookPath, script, { encoding: 'utf8', mode: HOOK_FILE_MODE });
      chmodSync(hookPath, HOOK_FILE_MODE);
      return { hookPath, status: 'updated' };
    }

    if (!options?.force) {
      throw new PrePushHookError(
        'EXISTING_CUSTOM_HOOK',
        `Refusing to overwrite existing custom pre-push hook at "${hookPath}" (missing "${PREFLIGHT_HOOK_MARKER}"). Pass --force to replace it, or chain "preflight check" manually in your existing hook.`,
      );
    }

    writeFileSync(hookPath, script, { encoding: 'utf8', mode: HOOK_FILE_MODE });
    chmodSync(hookPath, HOOK_FILE_MODE);
    return { hookPath, status: 'updated' };
  }

  writeFileSync(hookPath, script, { encoding: 'utf8', mode: HOOK_FILE_MODE });
  chmodSync(hookPath, HOOK_FILE_MODE);
  return { hookPath, status: 'installed' };
}
