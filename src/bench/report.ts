import { redactSecrets } from '../clients/http.js';
import { sanitizeBaseUrl } from '../telemetry/index.js';
import type { BenchCaseResult, BenchReport } from './types.js';

function formatRatio(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return `${numerator} / ${denominator} (n/a)`;
  }
  const pct = ((numerator / denominator) * 100).toFixed(1);
  return `${numerator} / ${denominator} (${pct}%)`;
}

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${value.toFixed(1)}ms`;
}

function formatTokPerSec(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${value.toFixed(1)} tok/s`;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function formatBoolCell(value: boolean | null): string {
  if (value === null) {
    return '-';
  }
  return value ? 'yes' : 'no';
}

function formatOutcomeCell(item: BenchCaseResult): string {
  if (item.error !== null) {
    return 'error';
  }
  if (item.status === 'fail') {
    return item.caught === true ? 'caught' : 'missed';
  }
  return item.falseAlarm === true ? 'false_alarm' : 'clean';
}

/**
 * Renders a crisp, secret-redacted Markdown benchmark report suitable for `bench/results/summary.md`.
 */
export function renderBenchSummaryMarkdown(report: BenchReport): string {
  const safeProvider = redactSecrets(report.provider);
  const safeModel = redactSecrets(report.model);
  const safeBaseUrl = sanitizeBaseUrl(report.baseUrl);
  const { metrics } = report;

  const lines: string[] = [
    '# Preflight Benchmark Summary',
    '',
    `- **Run Timestamp:** \`${report.runTimestamp}\``,
    `- **Evaluation Mode:** \`${report.mode}\``,
    `- **Provider / Model:** \`${safeProvider}\` / \`${safeModel}\``,
    `- **Base URL:** \`${safeBaseUrl}\``,
    `- **Cases Directory:** \`${report.casesDir}\``,
    '',
    '> **Honesty Note (`mode: triage`):** These metrics measure static Stage 2 (`Think`) triage predictions and Stage 3 (`Verify`) workflow-derived command allowlist validation against benchmark case metadata (`changed_files`, `workflow_file`, baseline CI commands) without leaking ground-truth status, logs, or root-cause labels. This is distinct from full local repository checkout and subprocess execution (see `bench/REPRO.md` for locally reproduced `<1s` anchor cases).',
    '',
    '## Summary Metrics',
    '',
    '| Metric | Value |',
    '| :--- | :--- |',
    `| total_cases | ${metrics.totalCases} (${metrics.failedCases} failed, ${metrics.passingCases} passing) |`,
    `| caught / failedCases | ${formatRatio(metrics.caught, metrics.failedCases)} |`,
    `| command_caught / failedCases | ${formatRatio(metrics.commandCaught, metrics.failedCases)} |`,
    `| target_caught / failedCases | ${formatRatio(metrics.targetCaught, metrics.failedCases)} |`,
    `| missed / failedCases | ${formatRatio(metrics.missed, metrics.failedCases)} |`,
    `| false_alarms / passingCases | ${formatRatio(metrics.falseAlarms, metrics.passingCases)} |`,
    `| allowlist_refusals | ${metrics.allowlistRefusals} |`,
    `| errors | ${metrics.errors} |`,
    `| median_wall_ms | ${formatMs(metrics.medianWallMs)} |`,
    `| p95_wall_ms | ${formatMs(metrics.p95WallMs)} |`,
    `| median_think_ms | ${formatMs(metrics.medianThinkMs)} |`,
    `| median_tok_per_s | ${formatTokPerSec(metrics.medianTokPerSec)} |`,
    '',
    '## Per-Case Results',
    '',
    '| Case ID | Repo | PR | Lang | Status | Outcome | Command | Target | Refused | Wall (ms) | Think (ms) | tok/s | Error |',
    '| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |',
  ];

  for (const item of report.cases) {
    const errorCell = item.error !== null ? escapeMarkdownCell(redactSecrets(item.error)) : '-';
    const tokCell =
      item.tokPerSec !== null && Number.isFinite(item.tokPerSec)
        ? item.tokPerSec.toFixed(1)
        : 'n/a';
    lines.push(
      `| \`${escapeMarkdownCell(item.id)}\` | ${escapeMarkdownCell(item.repo)} | #${item.pr} | ${escapeMarkdownCell(item.language)} | ${item.status} | ${formatOutcomeCell(item)} | ${formatBoolCell(item.commandCaught)} | ${formatBoolCell(item.targetCaught)} | ${item.refusedCommands.length} | ${item.wallTimeMs.toFixed(1)} | ${item.thinkMs.toFixed(1)} | ${tokCell} | ${errorCell} |`,
    );
  }

  return redactSecrets(lines.join('\n'));
}

/**
 * Formats a BenchReport into concise, secret-redacted terminal output.
 */
export function formatBenchReport(report: BenchReport): string {
  const safeProvider = redactSecrets(report.provider);
  const safeModel = redactSecrets(report.model);
  const safeBaseUrl = sanitizeBaseUrl(report.baseUrl);
  const { metrics } = report;

  const providerHeader =
    safeBaseUrl.length > 0
      ? `${safeProvider} / ${safeModel} (${safeBaseUrl})`
      : `${safeProvider} / ${safeModel}`;

  const lines: string[] = [
    `Preflight Benchmark (${report.mode})`,
    `  Provider           : ${providerHeader}`,
    `  Timestamp          : ${report.runTimestamp}`,
    `  Cases              : ${metrics.totalCases} total (${metrics.failedCases} failed, ${metrics.passingCases} passing)`,
    `  Caught (failed)    : ${formatRatio(metrics.caught, metrics.failedCases)} [command ${metrics.commandCaught}/${metrics.failedCases}, target ${metrics.targetCaught}/${metrics.failedCases}, missed ${metrics.missed}/${metrics.failedCases}]`,
    `  False alarms (pass): ${formatRatio(metrics.falseAlarms, metrics.passingCases)}`,
    `  Allowlist refusals : ${metrics.allowlistRefusals}`,
    `  Errors             : ${metrics.errors}`,
    `  Wall time          : median ${formatMs(metrics.medianWallMs)} | p95 ${formatMs(metrics.p95WallMs)}`,
    `  Think / throughput : median think ${formatMs(metrics.medianThinkMs)} | median ${formatTokPerSec(metrics.medianTokPerSec)}`,
  ];

  const erroredCases = report.cases.filter((item) => item.error !== null);
  if (erroredCases.length > 0) {
    lines.push('', 'Case errors:');
    for (const item of erroredCases) {
      lines.push(`  - ${item.id}: ${redactSecrets(item.error ?? '')}`);
    }
  }

  if (report.writtenFiles !== undefined) {
    lines.push(
      '',
      `Written summary : ${report.writtenFiles.summaryPath}`,
      `Written results : ${report.writtenFiles.resultsPath}`,
    );
  }

  lines.push(
    '',
    'Note: mode=triage evaluates static Think predictions + workflow allowlist validation (distinct from local repo checkout execution).',
  );

  return redactSecrets(lines.join('\n'));
}
