import { redactSecrets } from '../clients/http.js';
import type {
  ComputeTelemetryInput,
  StageTimingMs,
  TelemetryReport,
  TelemetryTimeInfo,
  TelemetryUsage,
  TokPerSecSource,
} from './types.js';

const SENSITIVE_QUERY_PARAM_RE =
  /^(?:api[_-]?key|key|token|access[_-]?token|secret|auth)$/i;

function roundOneDecimal(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

function toFiniteNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value === 0 ? 0 : value;
}

function toNonNegativeMs(value: number | undefined): number {
  const normalized = toFiniteNonNegative(value);
  return normalized ?? 0;
}

function normalizeUsage(
  usage: ComputeTelemetryInput['usage'],
): TelemetryUsage {
  if (!usage) {
    return {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
    };
  }

  const promptRaw = toFiniteNonNegative(usage.prompt_tokens);
  const completionRaw = toFiniteNonNegative(usage.completion_tokens);
  const totalRaw = toFiniteNonNegative(usage.total_tokens);

  const promptTokens = promptRaw !== null ? Math.round(promptRaw) : null;
  const completionTokens =
    completionRaw !== null ? Math.round(completionRaw) : null;

  let totalTokens: number | null;
  if (totalRaw !== null) {
    totalTokens = Math.round(totalRaw);
  } else if (
    usage.total_tokens === undefined &&
    promptTokens !== null &&
    completionTokens !== null
  ) {
    totalTokens = promptTokens + completionTokens;
  } else {
    totalTokens = null;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function normalizeTimeInfo(
  timeInfo: ComputeTelemetryInput['time_info'],
): TelemetryTimeInfo | null {
  if (!timeInfo) {
    return null;
  }

  const normalized: TelemetryTimeInfo = {
    queue_time: toFiniteNonNegative(timeInfo.queue_time),
    prompt_time: toFiniteNonNegative(timeInfo.prompt_time),
    completion_time: toFiniteNonNegative(timeInfo.completion_time),
    total_time: toFiniteNonNegative(timeInfo.total_time),
  };

  const hasAnyMetric =
    normalized.queue_time !== null ||
    normalized.prompt_time !== null ||
    normalized.completion_time !== null ||
    normalized.total_time !== null;

  return hasAnyMetric ? normalized : null;
}

/**
 * Strips embedded credentials and redacts sensitive query parameters or API keys from a base URL.
 */
export function sanitizeBaseUrl(
  baseUrl: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let sanitized = baseUrl;

  try {
    const parsed = new URL(baseUrl);
    let mutated = false;

    if (parsed.username.length > 0 || parsed.password.length > 0) {
      parsed.username = '';
      parsed.password = '';
      mutated = true;
    }

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAM_RE.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
        mutated = true;
      }
    }

    if (mutated) {
      sanitized = parsed.toString().replace(/%5BREDACTED%5D/g, '[REDACTED]');
    }
  } catch {
    // Non-URL strings still pass through redactSecrets below.
  }

  return redactSecrets(sanitized, secrets);
}

/**
 * Builds a structured Speed & Telemetry report from provider metadata, usage, optional time_info,
 * and stage wall-clock timings.
 */
export function computeTelemetry(
  input: ComputeTelemetryInput,
): TelemetryReport {
  const usage = normalizeUsage(input.usage);
  const timeInfo = normalizeTimeInfo(input.time_info);

  const rawGatherMs = toNonNegativeMs(input.timing_ms.gather_ms);
  const rawThinkMs = toNonNegativeMs(input.timing_ms.think_ms);
  const rawVerifyMs = toNonNegativeMs(input.timing_ms.verify_ms);
  const rawTotalWallMs =
    input.timing_ms.total_wall_ms !== undefined
      ? toNonNegativeMs(input.timing_ms.total_wall_ms)
      : rawGatherMs + rawThinkMs + rawVerifyMs;

  const timingMs: StageTimingMs = {
    gather_ms: roundOneDecimal(rawGatherMs),
    think_ms: roundOneDecimal(rawThinkMs),
    verify_ms: roundOneDecimal(rawVerifyMs),
    total_wall_ms: roundOneDecimal(rawTotalWallMs),
  };

  let tokPerSec: number | null = null;
  let tokPerSecSource: TokPerSecSource = null;

  const completionTokens = usage.completion_tokens;
  const completionTimeSec = timeInfo?.completion_time ?? null;

  if (
    completionTokens !== null &&
    completionTokens > 0 &&
    completionTimeSec !== null &&
    completionTimeSec > 0
  ) {
    tokPerSec = roundOneDecimal(completionTokens / completionTimeSec);
    tokPerSecSource = 'time_info';
  } else if (
    completionTokens !== null &&
    completionTokens > 0 &&
    rawThinkMs > 0
  ) {
    tokPerSec = roundOneDecimal(completionTokens / (rawThinkMs / 1000));
    tokPerSecSource = 'wall_time';
  }

  const secrets = input.secrets ?? [];

  return {
    provider: redactSecrets(input.provider, secrets),
    model: redactSecrets(input.model, secrets),
    base_url: sanitizeBaseUrl(input.base_url, secrets),
    usage,
    tok_per_s: tokPerSec,
    tok_per_s_source: tokPerSecSource,
    time_info: timeInfo,
    timing_ms: timingMs,
  };
}

function formatTokenCount(count: number | null): string {
  return count === null ? 'n/a' : String(count);
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) {
    return 'n/a';
  }
  if (seconds > 0 && seconds < 0.001) {
    return `${seconds.toFixed(4)}s`;
  }
  return `${seconds.toFixed(3)}s`;
}

function formatMsNumber(ms: number): string {
  const rounded = roundOneDecimal(ms);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatStageDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${formatMsNumber(ms)}ms`;
}

function formatTotalDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s (${formatMsNumber(ms)}ms)`;
  }
  if (ms > 0) {
    return `${formatMsNumber(ms)}ms (${(ms / 1000).toFixed(2)}s)`;
  }
  return '0ms';
}

/**
 * Formats a TelemetryReport into a readable, secret-free terminal Speed & Telemetry panel.
 */
export function formatSpeedPanel(report: TelemetryReport): string {
  const provider = redactSecrets(report.provider);
  const model = redactSecrets(report.model);
  const baseUrl = sanitizeBaseUrl(report.base_url);
  const providerLine =
    baseUrl.length > 0
      ? `${provider} / ${model} (${baseUrl})`
      : `${provider} / ${model}`;

  const tokensLine = `in ${formatTokenCount(report.usage.prompt_tokens)} | out ${formatTokenCount(report.usage.completion_tokens)} | total ${formatTokenCount(report.usage.total_tokens)}`;

  const throughputLine =
    report.tok_per_s !== null && report.tok_per_s_source !== null
      ? `${report.tok_per_s.toFixed(1)} tok/s (${report.tok_per_s_source})`
      : 'n/a';

  const timeInfoLine =
    report.time_info !== null
      ? `queue ${formatSeconds(report.time_info.queue_time)} | prompt ${formatSeconds(report.time_info.prompt_time)} | completion ${formatSeconds(report.time_info.completion_time)} | total ${formatSeconds(report.time_info.total_time)}`
      : 'n/a (client-measured)';

  const wallTimeLine = [
    `gather ${formatStageDuration(report.timing_ms.gather_ms)}`,
    `think ${formatStageDuration(report.timing_ms.think_ms)}`,
    `verify ${formatStageDuration(report.timing_ms.verify_ms)}`,
    `total ${formatTotalDuration(report.timing_ms.total_wall_ms)}`,
  ].join(' | ');

  const lines = [
    'Speed & Telemetry',
    `  Provider   : ${providerLine}`,
    `  Tokens     : ${tokensLine}`,
    `  Throughput : ${throughputLine}`,
    `  Time Info  : ${timeInfoLine}`,
    `  Wall Time  : ${wallTimeLine}`,
  ];

  return redactSecrets(lines.join('\n'));
}
