import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactSecrets } from '../clients/http.js';
import type { GitHubLogTarget, LoadCiLogOptions } from './types.js';

export const DEFAULT_MAX_LOG_CHARS = 24_000;
const DEFAULT_GH_MAX_BUFFER = 10 * 1024 * 1024;
const TRUNCATION_PREFIX = '...[earlier log truncated]\n';

const HTTP_URL_RE = /^https?:\/\//i;
const HTTPS_AUTHORITY_AND_PATH_RE = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i;
const GITHUB_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NUMERIC_ID_RE = /^\d{1,20}$/;

const FAILED_JOB_FALLBACK_CONCLUSIONS: ReadonlySet<string> = new Set([
  'timed_out',
  'startup_failure',
  'action_required',
]);

function isValidGitHubOwner(owner: string): boolean {
  return GITHUB_OWNER_RE.test(owner);
}

function isValidGitHubRepo(repo: string): boolean {
  return GITHUB_REPO_RE.test(repo) && !repo.includes('..');
}

function isValidNumericId(id: string): boolean {
  return NUMERIC_ID_RE.test(id);
}

/**
 * Parses a GitHub Actions run or job URL:
 * - https://github.com/{owner}/{repo}/actions/runs/{runId}
 * - https://github.com/{owner}/{repo}/actions/runs/{runId}/job/{jobId}
 *
 * Rejects non-HTTPS schemes, non-github.com hosts, embedded credentials/ports,
 * non-numeric IDs, and path/flag injection attempts.
 */
export function parseGitHubActionsUrl(url: string): GitHubLogTarget | null {
  const trimmed = url.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed) || trimmed.includes('\0')) {
    return null;
  }

  const rawMatch = HTTPS_AUTHORITY_AND_PATH_RE.exec(trimmed);
  if (rawMatch === null) {
    return null;
  }

  const rawAuthority = rawMatch[1];
  const rawPath = rawMatch[2];
  if (
    rawAuthority === undefined ||
    rawPath === undefined ||
    rawAuthority.toLowerCase() !== 'github.com'
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return null;
  }

  // Reject path normalization tricks (e.g. `..`, `//`, `\`).
  if (parsed.pathname !== rawPath) {
    return null;
  }

  const normalizedPath = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const segments = normalizedPath.split('/');

  if (segments.length !== 6 && segments.length !== 8) {
    return null;
  }

  const owner = segments[1];
  const repo = segments[2];
  const actionsSegment = segments[3];
  const runsSegment = segments[4];
  const runId = segments[5];

  if (
    owner === undefined ||
    repo === undefined ||
    actionsSegment !== 'actions' ||
    runsSegment !== 'runs' ||
    runId === undefined ||
    !isValidGitHubOwner(owner) ||
    !isValidGitHubRepo(repo) ||
    !isValidNumericId(runId)
  ) {
    return null;
  }

  if (segments.length === 6) {
    return { owner, repo, runId };
  }

  const jobSegment = segments[6];
  const jobId = segments[7];
  if (jobSegment !== 'job' || jobId === undefined || !isValidNumericId(jobId)) {
    return null;
  }

  return { owner, repo, runId, jobId };
}

function validateGitHubLogTarget(target: GitHubLogTarget): void {
  if (!isValidGitHubOwner(target.owner)) {
    throw new Error(`Invalid GitHub owner "${target.owner}"`);
  }
  if (!isValidGitHubRepo(target.repo)) {
    throw new Error(`Invalid GitHub repository "${target.repo}"`);
  }
  if (!isValidNumericId(target.runId)) {
    throw new Error(`Invalid GitHub Actions run ID "${target.runId}"`);
  }
  if (target.jobId !== undefined && !isValidNumericId(target.jobId)) {
    throw new Error(`Invalid GitHub Actions job ID "${target.jobId}"`);
  }
}

/**
 * Selects the first failed job ID from a GitHub Actions
 * `repos/{owner}/{repo}/actions/runs/{runId}/jobs` API response payload.
 */
export function selectFirstFailedJobId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const jobs = (payload as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) {
    return null;
  }

  let fallbackId: string | null = null;

  for (const entry of jobs) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }

    const job = entry as { id?: unknown; conclusion?: unknown };
    const rawId =
      typeof job.id === 'number' && Number.isInteger(job.id) && job.id >= 0
        ? String(job.id)
        : typeof job.id === 'string'
          ? job.id.trim()
          : null;

    if (rawId === null || !isValidNumericId(rawId)) {
      continue;
    }

    const conclusion = typeof job.conclusion === 'string' ? job.conclusion.toLowerCase() : '';
    if (conclusion === 'failure') {
      return rawId;
    }
    if (fallbackId === null && FAILED_JOB_FALLBACK_CONCLUSIONS.has(conclusion)) {
      fallbackId = rawId;
    }
  }

  return fallbackId;
}

function extractProcessErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = 'stderr' in error ? (error as { stderr?: unknown }).stderr : undefined;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return redactSecrets(stderr.trim());
    }
    if (Buffer.isBuffer(stderr)) {
      const text = stderr.toString('utf8').trim();
      if (text.length > 0) {
        return redactSecrets(text);
      }
    }
    if (error instanceof Error && error.message.trim().length > 0) {
      return redactSecrets(error.message.trim());
    }
  }
  return redactSecrets(typeof error === 'string' ? error.trim() : '');
}

function execGhApi(args: string[], contextDescription: string): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: DEFAULT_GH_MAX_BUFFER,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error: unknown) {
    const detail = extractProcessErrorMessage(error);
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const hint =
      code === 'ENOENT'
        ? ' (ensure GitHub CLI "gh" is installed and authenticated via "gh auth login")'
        : '';
    throw new Error(
      `Failed to fetch ${contextDescription} via gh CLI${detail ? `: ${detail}` : ''}${hint}`,
    );
  }
}

function fetchGitHubActionsLog(target: GitHubLogTarget): string {
  validateGitHubLogTarget(target);

  let jobId = target.jobId;
  if (jobId === undefined) {
    const jobsEndpoint = `repos/${target.owner}/${target.repo}/actions/runs/${target.runId}/jobs`;
    const jobsRaw = execGhApi(
      ['api', '--allow-escape-sequences', jobsEndpoint],
      `GitHub Actions jobs for run ${target.runId}`,
    );

    let parsedJobs: unknown;
    try {
      parsedJobs = JSON.parse(jobsRaw);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to parse GitHub Actions jobs response for run ${target.runId}: ${detail}`,
      );
    }

    const failedJobId = selectFirstFailedJobId(parsedJobs);
    if (failedJobId === null) {
      throw new Error(
        `No failed job found in GitHub Actions run ${target.runId} (${target.owner}/${target.repo}). Pass a specific job URL to inspect a non-failing job.`,
      );
    }
    jobId = failedJobId;
  }

  const logsEndpoint = `repos/${target.owner}/${target.repo}/actions/jobs/${jobId}/logs`;
  return execGhApi(
    ['api', '--allow-escape-sequences', logsEndpoint],
    `GitHub Actions log for job ${jobId}`,
  );
}

/**
 * Strips ANSI escape sequences (CSI, OSC, DCS/PM/APC, and 2-byte ESC sequences)
 * in linear time and normalizes CRLF line endings to LF.
 */
export function stripAnsi(input: string): string {
  let out = '';
  const len = input.length;
  let i = 0;

  while (i < len) {
    const code = input.charCodeAt(i);

    // 7-bit ESC (0x1b)
    if (code === 0x1b) {
      const next = i + 1 < len ? input.charCodeAt(i + 1) : -1;

      // CSI: ESC [ ... final byte (0x40-0x7e)
      if (next === 0x5b) {
        i += 2;
        while (i < len) {
          const c = input.charCodeAt(i);
          i += 1;
          if (c >= 0x40 && c <= 0x7e) {
            break;
          }
        }
        continue;
      }

      // OSC (ESC ]) or DCS/SOS/PM/APC (ESC P / X / ^ / _): terminated by BEL (0x07) or ST (ESC \)
      if (
        next === 0x5d ||
        next === 0x50 ||
        next === 0x58 ||
        next === 0x5e ||
        next === 0x5f
      ) {
        i += 2;
        while (i < len) {
          const c = input.charCodeAt(i);
          if (c === 0x07) {
            i += 1;
            break;
          }
          if (c === 0x1b && i + 1 < len && input.charCodeAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }

      // Character set designation sequences: ESC ( / ) / * / + / - / . / / followed by 1 byte
      if (
        next === 0x28 ||
        next === 0x29 ||
        next === 0x2a ||
        next === 0x2b ||
        next === 0x2d ||
        next === 0x2e ||
        next === 0x2f
      ) {
        i = Math.min(len, i + 3);
        continue;
      }

      // Standard 2-byte ESC sequence
      if (next >= 0x40 && next <= 0x7e) {
        i += 2;
        continue;
      }

      i += 1;
      continue;
    }

    // 8-bit CSI (0x9b)
    if (code === 0x9b) {
      i += 1;
      while (i < len) {
        const c = input.charCodeAt(i);
        i += 1;
        if (c >= 0x40 && c <= 0x7e) {
          break;
        }
      }
      continue;
    }

    // Normalize CRLF -> LF
    if (code === 0x0d && i + 1 < len && input.charCodeAt(i + 1) === 0x0a) {
      out += '\n';
      i += 2;
      continue;
    }

    out += input.charAt(i);
    i += 1;
  }

  return out;
}

/**
 * Bounds a CI log to its most recent tail (at most `maxChars` characters),
 * preserving stack traces and failure summaries at the end of the log.
 */
export function boundLogTail(
  log: string,
  maxChars: number = DEFAULT_MAX_LOG_CHARS,
): string {
  if (maxChars <= 0) {
    return '';
  }
  if (log.length <= maxChars) {
    return log;
  }
  if (maxChars <= TRUNCATION_PREFIX.length) {
    return log.slice(log.length - maxChars);
  }
  const keep = maxChars - TRUNCATION_PREFIX.length;
  return `${TRUNCATION_PREFIX}${log.slice(log.length - keep)}`;
}

/**
 * Loads a CI log from either a GitHub Actions run/job URL or a local file path,
 * strips ANSI escape sequences, and bounds the tail cleanly.
 */
export function loadCiLog(source: string, options: LoadCiLogOptions): string {
  const trimmedSource = source.trim();
  if (trimmedSource.length === 0) {
    throw new Error('CI log source must be a non-empty file path or GitHub Actions URL');
  }

  let rawLog: string;

  if (HTTP_URL_RE.test(trimmedSource)) {
    const parsed = parseGitHubActionsUrl(trimmedSource);
    if (parsed === null) {
      throw new Error(
        `Unsupported CI log URL "${trimmedSource}". Expected a GitHub Actions run or job URL (https://github.com/<owner>/<repo>/actions/runs/<runId>[/job/<jobId>]).`,
      );
    }

    rawLog = options.fetchGitHubLogFn
      ? options.fetchGitHubLogFn(parsed)
      : fetchGitHubActionsLog(parsed);
  } else {
    const resolvedPath = resolve(options.cwd, trimmedSource);
    try {
      rawLog = options.readFileFn
        ? options.readFileFn(resolvedPath)
        : readFileSync(resolvedPath, 'utf8');
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to read CI log file "${trimmedSource}" (${resolvedPath}): ${redactSecrets(detail)}`,
      );
    }
  }

  const cleaned = stripAnsi(rawLog);
  if (cleaned.trim().length === 0) {
    throw new Error(`CI log from "${trimmedSource}" is empty`);
  }

  const maxChars = options.maxChars ?? DEFAULT_MAX_LOG_CHARS;
  return boundLogTail(cleaned, maxChars);
}
