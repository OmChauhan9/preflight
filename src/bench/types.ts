import type { VerifyWorkflowCommand } from '../verify/index.js';

export type BenchStatusFilter = 'fail' | 'pass' | 'all';

export type BenchCaseStatus = 'fail' | 'pass';

export interface BenchLabelVerified {
  checked_against_log: boolean;
  checked_against_diff: boolean;
  notes: string;
}

export interface BenchCase {
  id: string;
  status: BenchCaseStatus;
  repo: string;
  pr: number;
  pr_url: string;
  language: string;
  base_sha: string;
  head_sha: string;
  workflow_file: string;
  run_id: number;
  run_url: string;
  failing_job: string | null;
  failing_command: string | null;
  log_excerpt: string | null;
  changed_files: string[];
  root_cause_label: string;
  label_verified: BenchLabelVerified;
}

export interface BenchClientMeta {
  provider: string;
  model: string;
  baseUrl: string;
}

export interface BenchCaseContext {
  budgetedContext: string;
  workflowCommands: VerifyWorkflowCommand[];
}

export interface LoadBenchCasesOptions {
  cwd: string;
  casesDir?: string;
  caseId?: string;
  status?: BenchStatusFilter;
  language?: string;
  limit?: number;
}

export interface BenchOptions {
  cwd: string;
  casesDir?: string;
  caseId?: string;
  status?: BenchStatusFilter;
  language?: string;
  limit?: number;
  outDir?: string;
  think?: boolean;
  delayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  maxCompletionTokens?: number;
  maxInputTokens?: number;
  secrets?: readonly string[];
  loadCaseContext?: (
    benchCase: BenchCase,
  ) => Promise<BenchCaseContext> | BenchCaseContext;
}

export interface BenchRefusedCommand {
  command: string;
  reason: string;
}

export interface BenchCaseUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface BenchCaseScore {
  caught: boolean | null;
  commandCaught: boolean | null;
  targetCaught: boolean | null;
  falseAlarm: boolean | null;
  predictedCommands: string[];
  allowedCommands: string[];
  refusedCommands: BenchRefusedCommand[];
}

export interface BenchCaseResult {
  id: string;
  repo: string;
  pr: number;
  language: string;
  status: BenchCaseStatus;
  caught: boolean | null;
  commandCaught: boolean | null;
  targetCaught: boolean | null;
  falseAlarm: boolean | null;
  predictedCommands: string[];
  allowedCommands: string[];
  refusedCommands: BenchRefusedCommand[];
  affectedJobs: string[];
  likelyFailureCount: number;
  thinkAttempts: number;
  wallTimeMs: number;
  thinkMs: number;
  tokPerSec: number | null;
  usage: BenchCaseUsage;
  error: string | null;
}

export interface BenchSummaryMetrics {
  totalCases: number;
  failedCases: number;
  passingCases: number;
  caught: number;
  commandCaught: number;
  targetCaught: number;
  missed: number;
  falseAlarms: number;
  allowlistRefusals: number;
  errors: number;
  medianWallMs: number | null;
  p95WallMs: number | null;
  medianThinkMs: number | null;
  medianTokPerSec: number | null;
}

export interface BenchWrittenFiles {
  summaryPath: string;
  resultsPath: string;
}

export interface BenchReport {
  mode: 'triage';
  provider: string;
  model: string;
  baseUrl: string;
  runTimestamp: string;
  casesDir: string;
  metrics: BenchSummaryMetrics;
  cases: BenchCaseResult[];
  writtenFiles?: BenchWrittenFiles;
}
