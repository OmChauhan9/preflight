export interface WorkflowCommand {
  file: string;
  job: string;
  stepName?: string;
  command: string;
  workingDirectory?: string;
}

export interface FileSnippet {
  path: string;
  content: string;
}

export type GitExecFn = (args: string[], cwd: string) => string;

export interface GatherOptions {
  cwd: string;
  baseRef?: string;
  recentCiLog?: string;
  maxInputTokens?: number;
  gitExec?: GitExecFn;
}

export interface GatherResult {
  baseRef: string;
  diff: string;
  changedFiles: string[];
  workflowCommands: WorkflowCommand[];
  affectedTests: FileSnippet[];
  changedFileContents: FileSnippet[];
  neighborContents: FileSnippet[];
  recentCiLog: string | null;
  budgetedContext: string;
  estimatedTokens: number;
  truncatedSections: string[];
  durationMs: number;
}

export interface GitDiffResult {
  baseRef: string;
  diff: string;
  changedFiles: string[];
}

export interface ImportGraphResult {
  affectedTests: FileSnippet[];
  neighborContents: FileSnippet[];
}

export interface BudgetContextParts {
  baseRef: string;
  diff: string;
  changedFiles: readonly string[];
  workflowCommands: readonly WorkflowCommand[];
  affectedTests: readonly FileSnippet[];
  changedFileContents: readonly FileSnippet[];
  neighborContents: readonly FileSnippet[];
  recentCiLog?: string | null;
}

export interface BudgetedContextResult {
  budgetedContext: string;
  estimatedTokens: number;
  truncatedSections: string[];
}
