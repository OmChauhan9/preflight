import { performance } from 'node:perf_hooks';
import { redactSecrets } from './clients/http.js';
import type { LlmClient } from './clients/types.js';
import { gatherContext, type GitExecFn } from './gather/index.js';
import {
  computeTelemetry,
  formatSpeedPanel,
  type TelemetryReport,
} from './telemetry/index.js';
import {
  runThink,
  type LikelyFailure,
  type ThinkOptions,
  type ThinkOutput,
} from './think/index.js';
import {
  runVerify,
  type CommandCheckResult,
  type SpawnCommandFn,
  type VerifyResult,
  type VerifyVerdict,
  type VerifyVerdictMessage,
} from './verify/index.js';

const MAX_EXCERPT_LINES = 16;
const MAX_EXCERPT_CHARS = 1200;

export interface CheckClientMeta {
  provider: string;
  model: string;
  baseUrl: string;
}

export interface CheckOptions {
  cwd: string;
  baseRef?: string;
  recentCiLog?: string;
  think?: boolean;
  maxInputTokens?: number;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  gitExec?: GitExecFn;
  spawnCommand?: SpawnCommandFn;
}

export interface CheckGatherSummary {
  estimatedTokens: number;
  truncatedSections: string[];
  workflowCommandCount: number;
  affectedTestCount: number;
}

export interface CheckReport {
  verdict: VerifyVerdict;
  verdictMessage: VerifyVerdictMessage;
  baseRef: string;
  changedFiles: string[];
  gather: CheckGatherSummary;
  think: ThinkOutput;
  thinkAttempts: 0 | 1 | 2;
  verify: VerifyResult;
  telemetry: TelemetryReport;
}

/**
 * Runs the full Preflight Phase 1 `check` pipeline:
 * Gather -> Think -> Verify -> Speed & Telemetry.
 *
 * When the working tree has no changes against `baseRef` (and no CI log is attached),
 * short-circuits with zero LLM calls and returns `no_checks_run`.
 */
export async function runCheck(
  options: CheckOptions,
  client: LlmClient,
  clientMeta: CheckClientMeta,
): Promise<CheckReport> {
  const totalStartMs = performance.now();

  const gathered = gatherContext({
    cwd: options.cwd,
    baseRef: options.baseRef,
    recentCiLog: options.recentCiLog,
    maxInputTokens: options.maxInputTokens,
    gitExec: options.gitExec,
  });

  const gatherSummary: CheckGatherSummary = {
    estimatedTokens: gathered.estimatedTokens,
    truncatedSections: gathered.truncatedSections,
    workflowCommandCount: gathered.workflowCommands.length,
    affectedTestCount: gathered.affectedTests.length,
  };

  if (
    gathered.changedFiles.length === 0 &&
    gathered.diff.trim().length === 0 &&
    gathered.recentCiLog === null
  ) {
    const totalWallMs = Math.max(
      0,
      performance.now() - totalStartMs,
      gathered.durationMs,
    );
    const verify: VerifyResult = {
      verdict: 'no_checks_run',
      verdictMessage: 'no allowlisted checks were executed',
      results: [],
      refusedCommands: [],
      durationMs: 0,
    };
    const telemetry = computeTelemetry({
      provider: clientMeta.provider,
      model: clientMeta.model,
      base_url: clientMeta.baseUrl,
      usage: null,
      time_info: null,
      timing_ms: {
        gather_ms: gathered.durationMs,
        think_ms: 0,
        verify_ms: 0,
        total_wall_ms: totalWallMs,
      },
    });

    return {
      verdict: verify.verdict,
      verdictMessage: verify.verdictMessage,
      baseRef: gathered.baseRef,
      changedFiles: [],
      gather: gatherSummary,
      think: {
        likely_failures: [],
        affected_jobs: [],
        commands: [],
        notes: `No changes detected against ${gathered.baseRef}; skipped LLM analysis and local checks.`,
      },
      thinkAttempts: 0,
      verify,
      telemetry,
    };
  }

  const thinkOptions: ThinkOptions = {};
  if (options.think !== undefined) {
    thinkOptions.think = options.think;
  }
  if (options.maxCompletionTokens !== undefined) {
    thinkOptions.maxCompletionTokens = options.maxCompletionTokens;
  }
  if (
    clientMeta.model.trim().length > 0 &&
    clientMeta.model !== client.model
  ) {
    thinkOptions.model = clientMeta.model;
  }

  const thinkStartMs = performance.now();
  const thinkResult = await runThink(
    {
      budgetedContext: gathered.budgetedContext,
      workflowCommands: gathered.workflowCommands,
      changedFiles: gathered.changedFiles,
    },
    client,
    thinkOptions,
  );
  const thinkMs = Math.max(
    0,
    performance.now() - thinkStartMs,
    thinkResult.wallTimeMs,
  );

  const verifyStartMs = performance.now();
  const verifyResult = await runVerify(
    thinkResult.output.commands,
    gathered.workflowCommands,
    {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      spawnCommand: options.spawnCommand,
    },
  );
  const verifyMs = Math.max(
    0,
    performance.now() - verifyStartMs,
    verifyResult.durationMs,
  );

  const totalWallMs = Math.max(
    0,
    performance.now() - totalStartMs,
    gathered.durationMs + thinkMs + verifyMs,
  );

  const telemetry = computeTelemetry({
    provider: clientMeta.provider,
    model: clientMeta.model,
    base_url: clientMeta.baseUrl,
    usage: thinkResult.usage,
    time_info: thinkResult.timeInfo,
    timing_ms: {
      gather_ms: gathered.durationMs,
      think_ms: thinkMs,
      verify_ms: verifyMs,
      total_wall_ms: totalWallMs,
    },
  });

  return {
    verdict: verifyResult.verdict,
    verdictMessage: verifyResult.verdictMessage,
    baseRef: gathered.baseRef,
    changedFiles: gathered.changedFiles,
    gather: gatherSummary,
    think: thinkResult.output,
    thinkAttempts: thinkResult.attempts,
    verify: verifyResult,
    telemetry,
  };
}

function formatStatusBadge(status: CommandCheckResult['status']): string {
  switch (status) {
    case 'passed':
      return 'PASS';
    case 'failed':
      return 'FAIL';
    case 'timed_out':
      return 'TIMEOUT';
    case 'refused':
      return 'REFUSED';
  }
}

function formatLikelyFailure(item: LikelyFailure): string {
  const metaParts: string[] = [];
  if (item.file && item.file.trim().length > 0) {
    metaParts.push(
      item.line !== undefined ? `${item.file}:${item.line}` : item.file,
    );
  }
  if (item.confidence !== undefined && Number.isFinite(item.confidence)) {
    metaParts.push(`confidence ${Math.round(item.confidence * 100)}%`);
  }
  const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
  return `  - [${item.category}] ${item.target}${metaSuffix} — ${item.reason}`;
}

function buildFailureExcerpt(result: CommandCheckResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const combined =
    stderr.length > 0 && stdout.length > 0
      ? `${stderr}\n${stdout}`
      : stderr.length > 0
        ? stderr
        : stdout;

  if (combined.length === 0) {
    return '';
  }

  let truncated = false;
  let lines = combined.split(/\r?\n/);
  if (lines.length > MAX_EXCERPT_LINES) {
    lines = lines.slice(lines.length - MAX_EXCERPT_LINES);
    truncated = true;
  }

  let excerpt = lines.join('\n');
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    excerpt = excerpt.slice(excerpt.length - MAX_EXCERPT_CHARS);
    truncated = true;
  }

  return truncated ? `... (truncated)\n${excerpt}` : excerpt;
}

function formatCommandCheck(result: CommandCheckResult): string[] {
  const badge = formatStatusBadge(result.status);
  const exitLabel =
    result.exitCode !== null ? `exit ${result.exitCode}` : 'exit n/a';
  const durationLabel = `${Math.round(result.durationMs)}ms`;
  const lines = [
    `  [${badge}] ${result.command} (${exitLabel}, ${durationLabel})`,
  ];

  if (result.status === 'refused') {
    const reason =
      result.refusalReason ??
      'command is not allowlisted by repository CI workflows';
    lines.push(`    Refused: ${reason}`);
    return lines;
  }

  if (result.status === 'failed' || result.status === 'timed_out') {
    const excerpt = buildFailureExcerpt(result);
    if (excerpt.length > 0) {
      lines.push('    Output:');
      for (const line of excerpt.split(/\r?\n/)) {
        lines.push(`      ${line}`);
      }
    } else if (result.status === 'timed_out') {
      lines.push('    Timed out before exiting.');
    }
  }

  return lines;
}

/**
 * Formats a CheckReport into concise, exit-code-backed terminal output including
 * predicted likely failures, executed/refused command outcomes, and the Speed Panel.
 */
export function formatCheckReport(report: CheckReport): string {
  const lines: string[] = [
    `Verdict: ${report.verdictMessage}`,
    `Base: ${report.baseRef} | Changed files: ${report.changedFiles.length} | CI commands: ${report.gather.workflowCommandCount}`,
  ];

  if (report.think.likely_failures.length > 0) {
    lines.push('', 'Predicted likely failures:');
    for (const failure of report.think.likely_failures) {
      lines.push(formatLikelyFailure(failure));
    }
  }

  if (report.verify.results.length > 0) {
    lines.push('', 'Checks:');
    for (const result of report.verify.results) {
      lines.push(...formatCommandCheck(result));
    }
  } else {
    lines.push('', 'Checks: none executed');
  }

  const trimmedNotes = report.think.notes.trim();
  if (trimmedNotes.length > 0) {
    lines.push('', `Notes: ${trimmedNotes}`);
  }

  lines.push('', formatSpeedPanel(report.telemetry));

  return redactSecrets(lines.join('\n'));
}
