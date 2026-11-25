import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitDiffResult, GitExecFn } from './types.js';

export const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024;
export const DEFAULT_BASE_REF_CANDIDATES = [
  'origin/main',
  'main',
  'origin/master',
  'master',
  'HEAD',
] as const;

const MAX_SYNTHETIC_DIFF_FILE_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export class GatherGitError extends Error {
  readonly args: readonly string[];
  readonly cwd: string;

  constructor(
    message: string,
    options: { args?: readonly string[]; cwd: string; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GatherGitError';
    this.args = options.args ?? [];
    this.cwd = options.cwd;
  }
}

function extractGitErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = 'stderr' in error ? (error as { stderr?: unknown }).stderr : undefined;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim();
    }
    if (Buffer.isBuffer(stderr)) {
      const text = stderr.toString('utf8').trim();
      if (text.length > 0) {
        return text;
      }
    }
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }
  }
  return typeof error === 'string' ? error.trim() : '';
}

export function execGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error: unknown) {
    const detail = extractGitErrorMessage(error);
    throw new GatherGitError(
      `git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`,
      { args, cwd, cause: error },
    );
  }
}

export function normalizeRepoPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+/g, '/');
}

export function unquoteGitPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  const bytes: number[] = [];

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') {
      const encoded = Buffer.from(ch ?? '', 'utf8');
      for (const byte of encoded) {
        bytes.push(byte);
      }
      continue;
    }

    const next = inner[i + 1];
    if (next === undefined) {
      bytes.push('\\'.charCodeAt(0));
      break;
    }

    if (next >= '0' && next <= '7') {
      const octSlice = inner.slice(i + 1, i + 4);
      const octMatch = /^[0-7]{1,3}/.exec(octSlice);
      if (octMatch?.[0]) {
        bytes.push(Number.parseInt(octMatch[0], 8) & 0xff);
        i += octMatch[0].length;
        continue;
      }
    }

    i += 1;
    switch (next) {
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case '\\':
        bytes.push(0x5c);
        break;
      default: {
        const encoded = Buffer.from(next, 'utf8');
        for (const byte of encoded) {
          bytes.push(byte);
        }
        break;
      }
    }
  }

  return Buffer.from(bytes).toString('utf8');
}

function stripDiffPrefix(rawPath: string, prefix: 'a/' | 'b/'): string {
  const unquoted = unquoteGitPath(rawPath);
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

function extractBPathFromDiffHeader(line: string): string | null {
  const rest = line.slice('diff --git '.length);
  const quotedMatch = /^"a\/(?:\\.|[^"\\])*" "b\/((?:\\.|[^"\\])*)"$/.exec(rest);
  if (quotedMatch?.[1]) {
    return unquoteGitPath(`"${quotedMatch[1]}"`);
  }
  const splitIdx = rest.lastIndexOf(' b/');
  if (splitIdx !== -1) {
    return unquoteGitPath(rest.slice(splitIdx + ' b/'.length));
  }
  return null;
}

export function parseChangedFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  const addFile = (rawPath: string): void => {
    const normalized = normalizeRepoPath(unquoteGitPath(rawPath));
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      files.push(normalized);
    }
  };

  const lines = diff.replace(/\r\n?/g, '\n').split('\n');
  let currentHeaderFallback: string | null = null;
  let currentMinusPath: string | null = null;
  let currentBlockRecorded = false;

  const flushBlock = (): void => {
    if (!currentBlockRecorded) {
      if (currentHeaderFallback !== null) {
        addFile(currentHeaderFallback);
      } else if (currentMinusPath !== null) {
        addFile(currentMinusPath);
      }
    }
    currentHeaderFallback = null;
    currentMinusPath = null;
    currentBlockRecorded = false;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushBlock();
      currentHeaderFallback = extractBPathFromDiffHeader(line);
      continue;
    }

    if (line.startsWith('rename to ')) {
      addFile(line.slice('rename to '.length));
      currentBlockRecorded = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      const raw = line.slice('--- '.length).trim();
      if (raw !== '/dev/null') {
        currentMinusPath = stripDiffPrefix(raw, 'a/');
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      const raw = line.slice('+++ '.length).trim();
      if (raw !== '/dev/null') {
        addFile(stripDiffPrefix(raw, 'b/'));
        currentBlockRecorded = true;
      } else if (currentMinusPath !== null) {
        addFile(currentMinusPath);
        currentBlockRecorded = true;
      }
    }
  }

  flushBlock();
  return files;
}

export function resolveBaseRef(
  cwd: string,
  baseRef?: string,
  gitExec: GitExecFn = execGit,
): string {
  if (baseRef !== undefined) {
    const trimmed = baseRef.trim();
    if (trimmed.length === 0) {
      throw new GatherGitError('Invalid empty base ref', { cwd });
    }
    if (trimmed.startsWith('-')) {
      throw new GatherGitError(
        `Invalid base ref "${trimmed}": ref must not start with "-"`,
        { cwd },
      );
    }

    const verifyArgs = ['rev-parse', '--verify', `${trimmed}^{commit}`];
    try {
      gitExec(verifyArgs, cwd);
      return trimmed;
    } catch (error: unknown) {
      const detail = extractGitErrorMessage(error);
      throw new GatherGitError(
        `Invalid base ref "${trimmed}": ref does not exist or is not a commit${detail ? ` (${detail})` : ''}`,
        { args: verifyArgs, cwd, cause: error },
      );
    }
  }

  for (const candidate of DEFAULT_BASE_REF_CANDIDATES) {
    try {
      const candidateSpec = gitExec === execGit ? `${candidate}^{commit}` : candidate;
      gitExec(['rev-parse', '--verify', candidateSpec], cwd);
      return candidate;
    } catch {
      // Try next candidate ref
    }
  }

  throw new GatherGitError(
    `Could not detect a valid base ref in "${cwd}" (tried: ${DEFAULT_BASE_REF_CANDIDATES.join(', ')})`,
    { cwd },
  );
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLen = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sampleLen; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function buildSyntheticAddedFileDiff(cwd: string, relPath: string): string | null {
  const fullPath = join(cwd, relPath);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(fullPath);
  } catch {
    return null;
  }

  if (!stats.isFile()) {
    return null;
  }

  if (stats.size > MAX_SYNTHETIC_DIFF_FILE_BYTES) {
    return [
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      `--- /dev/null`,
      `+++ b/${relPath}`,
      `@@ -0,0 +1,1 @@`,
      `+(untracked file omitted from diff: ${stats.size} bytes)`,
    ].join('\n');
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(fullPath);
  } catch {
    return null;
  }

  if (isLikelyBinary(buffer)) {
    return [
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      `Binary files /dev/null and b/${relPath} differ`,
    ].join('\n');
  }

  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
  ];

  if (buffer.length === 0) {
    return header.join('\n');
  }

  const text = buffer.toString('utf8').replace(/\r\n?/g, '\n');
  const rawLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const addedLines = rawLines.map((line) => `+${line}`);

  return [...header, `@@ -0,0 +1,${rawLines.length} @@`, ...addedLines].join('\n');
}

function parseLineList(output: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const normalized = normalizeRepoPath(unquoteGitPath(trimmed));
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  }
  return results;
}

export interface CollectGitDiffOptions {
  cwd: string;
  baseRef?: string;
  gitExec?: GitExecFn;
}

export function collectGitDiff(options: CollectGitDiffOptions): GitDiffResult {
  const gitExec = options.gitExec ?? execGit;
  const baseRef = resolveBaseRef(options.cwd, options.baseRef, gitExec);

  let trackedDiff: string;
  const diffArgs = ['diff', baseRef, '--'];
  try {
    trackedDiff = gitExec(diffArgs, options.cwd);
  } catch (error: unknown) {
    if (error instanceof GatherGitError) {
      throw error;
    }
    const detail = extractGitErrorMessage(error);
    throw new GatherGitError(
      `Failed to collect git diff against "${baseRef}"${detail ? `: ${detail}` : ''}`,
      { args: diffArgs, cwd: options.cwd, cause: error },
    );
  }

  const changedFileSet = new Set<string>();

  try {
    const nameOnlyOutput = gitExec(['diff', '--name-only', baseRef, '--'], options.cwd);
    const trimmedNameOnly = nameOnlyOutput.trimStart();
    if (trimmedNameOnly.length > 0 && !trimmedNameOnly.startsWith('diff --git ')) {
      for (const file of parseLineList(nameOnlyOutput)) {
        changedFileSet.add(file);
      }
    }
  } catch {
    // Fallback to paths parsed from unified diff output
  }

  for (const file of parseChangedFilesFromDiff(trackedDiff)) {
    changedFileSet.add(file);
  }

  let untrackedFiles: string[] = [];
  try {
    const lsFilesOutput = gitExec(
      ['ls-files', '--others', '--exclude-standard'],
      options.cwd,
    );
    untrackedFiles = parseLineList(lsFilesOutput);
  } catch {
    untrackedFiles = [];
  }

  const syntheticDiffParts: string[] = [];
  for (const untrackedPath of untrackedFiles) {
    if (changedFileSet.has(untrackedPath)) {
      continue;
    }
    changedFileSet.add(untrackedPath);
    const synthetic = buildSyntheticAddedFileDiff(options.cwd, untrackedPath);
    if (synthetic !== null) {
      syntheticDiffParts.push(synthetic);
    }
  }

  const diffChunks: string[] = [];
  const trimmedTracked = trackedDiff.trimEnd();
  if (trimmedTracked.length > 0) {
    diffChunks.push(trimmedTracked);
  }
  for (const synthetic of syntheticDiffParts) {
    diffChunks.push(synthetic);
  }

  return {
    baseRef,
    diff: diffChunks.join('\n'),
    changedFiles: Array.from(changedFileSet),
  };
}
