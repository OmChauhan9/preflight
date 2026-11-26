import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultSleep, redactSecrets } from '../clients/http.js';
import type { LlmClient } from '../clients/types.js';
import { computeTelemetry, sanitizeBaseUrl } from '../telemetry/index.js';
import {
  runThink,
  ThinkValidationError,
  type ThinkOptions,
} from '../think/index.js';
import { loadBenchCases } from './loader.js';
import { renderBenchSummaryMarkdown } from './report.js';
import {
  aggregateBenchMetrics,
  buildDefaultCaseContext,
  scoreBenchCase,
} from './scorer.js';
import type {
  BenchCaseResult,
  BenchClientMeta,
  BenchOptions,
  BenchReport,
  LoadBenchCasesOptions,
} from './types.js';

function roundOneDecimal(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

function formatReportCasesDir(cwd: string, resolvedCasesDir: string): string {
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedCwd, resolvedCasesDir);
  if (relative === '') {
    return '.';
  }
  const isOutside =
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (isOutside) {
    return resolvedCasesDir;
  }
  return relative.split(path.sep).join('/');
}

function serializeRedactedReportJson(
  report: BenchReport,
  secrets: readonly string[] = [],
): string {
  const json = JSON.stringify(
    report,
    (_key, value: unknown) =>
      typeof value === 'string' ? redactSecrets(value, secrets) : value,
    2,
  );
  return `${redactSecrets(json, secrets)}\n`;
}

/**
 * Runs the sequential (single-flight) Preflight benchmark evaluation loop across
 * loaded `bench/cases/*.json` cases, scores Think outputs against workflow-derived
 * allowlists and ground-truth labels, and optionally writes `summary.md` and `results.json`.
 */
export async function runBench(
  options: BenchOptions,
  client: LlmClient,
  clientMeta: BenchClientMeta,
): Promise<BenchReport> {
  if (
    options.maxCompletionTokens !== undefined &&
    (!Number.isInteger(options.maxCompletionTokens) ||
      options.maxCompletionTokens <= 0)
  ) {
    throw new RangeError('maxCompletionTokens must be a positive integer');
  }

  if (
    options.maxInputTokens !== undefined &&
    (!Number.isFinite(options.maxInputTokens) || options.maxInputTokens < 0)
  ) {
    throw new RangeError('maxInputTokens must be a non-negative finite number');
  }

  if (
    options.delayMs !== undefined &&
    (!Number.isFinite(options.delayMs) ||
      !Number.isInteger(options.delayMs) ||
      options.delayMs < 0)
  ) {
    throw new RangeError('delayMs must be a non-negative finite integer');
  }

  const resolvedCasesDir =
    options.casesDir !== undefined && options.casesDir.trim().length > 0
      ? path.resolve(options.cwd, options.casesDir)
      : path.resolve(options.cwd, 'bench/cases');

  const loadOptions: LoadBenchCasesOptions = {
    cwd: options.cwd,
    casesDir: resolvedCasesDir,
  };
  if (options.caseId !== undefined) {
    loadOptions.caseId = options.caseId;
  }
  if (options.status !== undefined) {
    loadOptions.status = options.status;
  }
  if (options.language !== undefined) {
    loadOptions.language = options.language;
  }
  if (options.limit !== undefined) {
    loadOptions.limit = options.limit;
  }

  const cases = loadBenchCases(loadOptions);
  const runTimestamp = new Date().toISOString();
  const secrets = options.secrets ?? [];
  const safeProvider = redactSecrets(clientMeta.provider, secrets);
  const safeModel = redactSecrets(clientMeta.model, secrets);
  const safeBaseUrl = sanitizeBaseUrl(clientMeta.baseUrl, secrets);

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

  const delayMs = options.delayMs ?? 0;
  const sleep = options.sleepFn ?? defaultSleep;
  const results: BenchCaseResult[] = [];

  // Strictly sequential single-flight execution across benchmark cases.
  for (const [index, benchCase] of cases.entries()) {
    if (index > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    const caseStartMs = performance.now();
    let thinkStartMs: number | null = null;

    try {
      const context = options.loadCaseContext
        ? await options.loadCaseContext(benchCase)
        : buildDefaultCaseContext(benchCase, options.maxInputTokens);

      thinkStartMs = performance.now();
      const thinkResult = await runThink(
        {
          budgetedContext: context.budgetedContext,
          workflowCommands: context.workflowCommands,
          changedFiles: benchCase.changed_files,
        },
        client,
        thinkOptions,
      );
      const measuredThinkMs = Math.max(0, performance.now() - thinkStartMs);
      const thinkMs = Math.max(measuredThinkMs, thinkResult.wallTimeMs);

      const score = scoreBenchCase(
        benchCase,
        thinkResult.output,
        context.workflowCommands,
      );

      const measuredWallMs = Math.max(0, performance.now() - caseStartMs);
      const totalWallMs = Math.max(measuredWallMs, thinkMs);

      const telemetry = computeTelemetry({
        provider: safeProvider,
        model: safeModel,
        base_url: safeBaseUrl,
        usage: thinkResult.usage,
        time_info: thinkResult.timeInfo,
        timing_ms: {
          gather_ms: 0,
          think_ms: thinkMs,
          verify_ms: 0,
          total_wall_ms: totalWallMs,
        },
        secrets,
      });

      results.push({
        id: benchCase.id,
        repo: benchCase.repo,
        pr: benchCase.pr,
        language: benchCase.language,
        status: benchCase.status,
        caught: score.caught,
        commandCaught: score.commandCaught,
        targetCaught: score.targetCaught,
        falseAlarm: score.falseAlarm,
        predictedCommands: score.predictedCommands,
        allowedCommands: score.allowedCommands,
        refusedCommands: score.refusedCommands,
        affectedJobs: [...thinkResult.output.affected_jobs],
        likelyFailureCount: thinkResult.output.likely_failures.length,
        thinkAttempts: thinkResult.attempts,
        wallTimeMs: telemetry.timing_ms.total_wall_ms,
        thinkMs: telemetry.timing_ms.think_ms,
        tokPerSec: telemetry.tok_per_s,
        usage: telemetry.usage,
        error: null,
      });
    } catch (error: unknown) {
      const nowMs = performance.now();
      const wallTimeMs = roundOneDecimal(Math.max(0, nowMs - caseStartMs));
      const thinkMs =
        thinkStartMs !== null
          ? roundOneDecimal(Math.max(0, nowMs - thinkStartMs))
          : 0;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const safeError = redactSecrets(rawMessage, secrets);

      results.push({
        id: benchCase.id,
        repo: benchCase.repo,
        pr: benchCase.pr,
        language: benchCase.language,
        status: benchCase.status,
        caught: null,
        commandCaught: null,
        targetCaught: null,
        falseAlarm: null,
        predictedCommands: [],
        allowedCommands: [],
        refusedCommands: [],
        affectedJobs: [],
        likelyFailureCount: 0,
        thinkAttempts: error instanceof ThinkValidationError ? error.attempts : 0,
        wallTimeMs,
        thinkMs,
        tokPerSec: null,
        usage: {
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
        },
        error: safeError,
      });
    }
  }

  const metrics = aggregateBenchMetrics(results);

  const report: BenchReport = {
    mode: 'triage',
    provider: safeProvider,
    model: safeModel,
    baseUrl: safeBaseUrl,
    runTimestamp,
    casesDir: formatReportCasesDir(options.cwd, resolvedCasesDir),
    metrics,
    cases: results,
  };

  if (options.outDir !== undefined && options.outDir.trim().length > 0) {
    const resolvedOutDir = path.resolve(options.cwd, options.outDir);
    mkdirSync(resolvedOutDir, { recursive: true });
    const summaryPath = path.join(resolvedOutDir, 'summary.md');
    const resultsPath = path.join(resolvedOutDir, 'results.json');

    const summaryMarkdown = `${redactSecrets(renderBenchSummaryMarkdown(report, secrets), secrets)}\n`;
    const resultsJson = serializeRedactedReportJson(report, secrets);

    writeFileSync(summaryPath, summaryMarkdown, 'utf8');
    writeFileSync(resultsPath, resultsJson, 'utf8');
    report.writtenFiles = { summaryPath, resultsPath };
  }

  return report;
}
