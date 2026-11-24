import type { GitExecFn } from '../gather/types.js';
import type { TelemetryReport } from '../telemetry/types.js';
import type { SpawnCommandFn, VerifyResult } from '../verify/types.js';

export interface ExplainOutput {
  root_cause: string;
  failing_command: string | null;
  suggested_patch: string;
  explanation: string;
}

export interface ExplainClientMeta {
  provider: string;
  model: string;
  baseUrl: string;
}

export interface GitHubLogTarget {
  owner: string;
  repo: string;
  runId: string;
  jobId?: string;
}

export interface LoadCiLogOptions {
  cwd: string;
  maxChars?: number;
  readFileFn?: (filePath: string) => string;
  fetchGitHubLogFn?: (parsed: GitHubLogTarget) => string;
}

export interface ExplainOptions {
  source: string;
  cwd: string;
  baseRef?: string;
  think?: boolean;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  verify?: boolean;
  maxInputTokens?: number;
  readFileFn?: (filePath: string) => string;
  fetchGitHubLogFn?: (parsed: GitHubLogTarget) => string;
  gitExec?: GitExecFn;
  spawnCommand?: SpawnCommandFn;
}

export interface ExplainResult {
  source: string;
  output: ExplainOutput;
  attempts: 1 | 2;
  verification: VerifyResult | null;
  telemetry: TelemetryReport;
}

export type ExplainValidationResult =
  | { ok: true; value: ExplainOutput }
  | { ok: false; errors: string[] };

export class ExplainValidationError extends Error {
  readonly attempts: number;
  readonly validationErrors: string[];
  readonly lastRawContent: string;

  constructor(
    message: string,
    options: {
      attempts: number;
      validationErrors: readonly string[];
      lastRawContent: string;
    },
  ) {
    super(message);
    this.name = 'ExplainValidationError';
    this.attempts = options.attempts;
    this.validationErrors = [...options.validationErrors];
    this.lastRawContent = options.lastRawContent;
  }
}
