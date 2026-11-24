export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 32_768;

export interface VerifyWorkflowCommand {
  file: string;
  job: string;
  command: string;
  workingDirectory?: string;
}

export type TokenizeResult =
  | {
      ok: true;
      tokens: string[];
    }
  | {
      ok: false;
      reason: string;
    };

export type AllowlistDecision =
  | {
      allowed: true;
      binary: string;
      args: string[];
      matchedWorkflowCommand: string;
      workingDirectory?: string;
    }
  | {
      allowed: false;
      reason: string;
    };

export type CommandCheckStatus = 'passed' | 'failed' | 'timed_out' | 'refused';

export interface CommandCheckResult {
  command: string;
  status: CommandCheckStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  matchedWorkflowCommand?: string;
  refusalReason?: string;
}

export type VerifyVerdict = 'passed' | 'failed' | 'no_checks_run';

export type VerifyVerdictMessage =
  | 'these checks passed'
  | 'these checks failed'
  | 'no allowlisted checks were executed';

export interface RefusedCommand {
  command: string;
  reason: string;
}

export interface VerifyResult {
  verdict: VerifyVerdict;
  verdictMessage: VerifyVerdictMessage;
  results: CommandCheckResult[];
  refusedCommands: RefusedCommand[];
  durationMs: number;
}

export interface ExecuteCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ExecuteCommandResult {
  status: 'passed' | 'failed' | 'timed_out';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export type SpawnCommandFn = (
  binary: string,
  args: readonly string[],
  options: ExecuteCommandOptions,
) => Promise<ExecuteCommandResult>;

export interface VerifyOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnCommand?: SpawnCommandFn;
}
