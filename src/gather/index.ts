import { performance } from 'node:perf_hooks';
import { buildBudgetedContext, DEFAULT_MAX_INPUT_TOKENS } from './budget.js';
import { collectGitDiff } from './git.js';
import { findAffectedTestsAndNeighbors, readFileContentSafe } from './import-graph.js';
import type { FileSnippet, GatherOptions, GatherResult } from './types.js';
import { loadWorkflowCommands } from './workflows.js';

export {
  buildBudgetedContext,
  DEFAULT_MAX_INPUT_TOKENS,
  estimateTokens,
} from './budget.js';
export {
  collectGitDiff,
  DEFAULT_BASE_REF_CANDIDATES,
  DEFAULT_GIT_MAX_BUFFER,
  execGit,
  GatherGitError,
  normalizeRepoPath,
  parseChangedFilesFromDiff,
  resolveBaseRef,
  unquoteGitPath,
  type CollectGitDiffOptions,
} from './git.js';
export {
  extractJsTsImports,
  extractPythonImports,
  findAffectedTestsAndNeighbors,
  isSupportedCodeFile,
  isTestFile,
  readFileContentSafe,
  resolveJsTsImport,
  resolvePythonImport,
  type PythonImportSpec,
} from './import-graph.js';
export {
  loadWorkflowCommands,
  parseWorkflowYaml,
  splitShellCommands,
} from './workflows.js';
export type {
  BudgetContextParts,
  BudgetedContextResult,
  FileSnippet,
  GatherOptions,
  GatherResult,
  GitDiffResult,
  GitExecFn,
  ImportGraphResult,
  WorkflowCommand,
} from './types.js';

export function gatherContext(options: GatherOptions): GatherResult {
  const startMs = performance.now();

  const { baseRef, diff, changedFiles } = collectGitDiff({
    cwd: options.cwd,
    baseRef: options.baseRef,
    gitExec: options.gitExec,
  });

  const workflowCommands = loadWorkflowCommands(options.cwd);
  const { affectedTests, neighborContents } = findAffectedTestsAndNeighbors(
    options.cwd,
    changedFiles,
  );

  const changedFileContents: FileSnippet[] = [];
  for (const relPath of changedFiles) {
    const content = readFileContentSafe(options.cwd, relPath);
    if (content !== null) {
      changedFileContents.push({ path: relPath, content });
    }
  }

  const recentCiLog =
    options.recentCiLog !== undefined && options.recentCiLog.trim().length > 0
      ? options.recentCiLog
      : null;

  const budgeted = buildBudgetedContext(
    {
      baseRef,
      diff,
      changedFiles,
      workflowCommands,
      affectedTests,
      changedFileContents,
      neighborContents,
      recentCiLog,
    },
    options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
  );

  const durationMs = Math.max(0, performance.now() - startMs);

  return {
    baseRef,
    diff,
    changedFiles,
    workflowCommands,
    affectedTests,
    changedFileContents,
    neighborContents,
    recentCiLog,
    budgetedContext: budgeted.budgetedContext,
    estimatedTokens: budgeted.estimatedTokens,
    truncatedSections: budgeted.truncatedSections,
    durationMs,
  };
}
