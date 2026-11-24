import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  FetchLike,
  RawChatCompletionResponse,
  RetryOptions,
  SleepFn,
} from './types.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 500;

/**
 * Serializes async tasks so only one request runs at a time within a process.
 */
export class SingleFlightQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Shared process-wide single-flight queue to protect against concurrent bursts.
 */
export const sharedSingleFlightQueue = new SingleFlightQueue();

export class LlmHttpError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: { provider: string; status?: number; retryAfterMs?: number | null },
  ) {
    super(message);
    this.name = 'LlmHttpError';
    this.provider = options.provider;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes API keys and Authorization credentials from text before throwing or logging.
 */
export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let sanitized = text;

  const uniqueSecrets = Array.from(
    new Set(
      secrets
        .map((secret) => secret?.trim())
        .filter((secret): secret is string => Boolean(secret && secret.length > 0)),
    ),
  ).sort((a, b) => b.length - a.length);

  for (const secret of uniqueSecrets) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }

  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(
    /Authorization\s*:\s*[^\r\n,;]+/gi,
    'Authorization: [REDACTED]',
  );
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9_-])(?:(?:csk|sk)-|gsk_|AIza)[A-Za-z0-9_-]{8,}/g,
    '[REDACTED]',
  );

  return sanitized;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Parses an HTTP `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(
  headerValue: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!headerValue) {
    return null;
  }

  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
    return null;
  }

  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedDateMs)) {
    return Math.max(0, parsedDateMs - nowMs);
  }

  return null;
}

/**
 * Computes the next retry delay in milliseconds using Retry-After when present,
 * or bounded exponential backoff with equal jitter otherwise.
 */
export function computeRetryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  options: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  if (retryAfterMs !== null) {
    return Math.min(options.maxDelayMs, Math.max(0, Math.round(retryAfterMs)));
  }

  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * Math.pow(2, attempt),
  );
  const clampedRandom = Math.min(1, Math.max(0, options.random()));
  const jittered = exponential * (0.5 + 0.5 * clampedRandom);
  return Math.min(options.maxDelayMs, Math.max(0, Math.round(jittered)));
}

export const defaultSleep: SleepFn = (ms: number, signal?: AbortSignal) => {
  if (signal?.aborted) {
    return Promise.reject(new Error('Request aborted during retry backoff'));
  }

  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Request aborted during retry backoff'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

function truncateSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_ERROR_BODY_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_ERROR_BODY_LENGTH)}...`;
}

function createRequestSignal(
  timeoutMs: number | undefined,
  externalSignal: AbortSignal | undefined,
): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  if (timeoutMs === undefined) {
    return {
      signal: externalSignal,
      cleanup: () => undefined,
      didTimeout: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
    didTimeout: () => timedOut,
  };
}

export interface PostChatCompletionParams {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  requiresApiKey?: boolean;
  apiKeyEnvVar?: string;
  model: string | undefined;
  modelEnvVar?: string;
  request: ChatCompletionRequest;
  fetch?: FetchLike;
  queue?: SingleFlightQueue;
  retry?: RetryOptions;
  timeoutMs?: number;
}

/**
 * Executes an OpenAI-compatible `POST /chat/completions` request through a
 * single-flight queue with HTTP 429 retry and strict secret redaction.
 */
export async function postChatCompletion(
  params: PostChatCompletionParams,
): Promise<ChatCompletionResult> {
  const rawApiKey = params.apiKey?.trim();
  const apiKey = rawApiKey && rawApiKey.length > 0 ? rawApiKey : undefined;

  if (params.requiresApiKey && !apiKey) {
    const envHint =
      params.apiKeyEnvVar && params.apiKeyEnvVar !== 'PREFLIGHT_API_KEY'
        ? `PREFLIGHT_API_KEY or ${params.apiKeyEnvVar}`
        : 'PREFLIGHT_API_KEY';
    throw new LlmHttpError(
      `Missing API key for ${params.provider}: set ${envHint} or pass apiKey`,
      { provider: params.provider },
    );
  }

  const baseUrl = normalizeBaseUrl(params.baseUrl.trim());
  if (!baseUrl) {
    throw new LlmHttpError(
      `Missing base URL for ${params.provider}: set PREFLIGHT_BASE_URL or pass baseUrl`,
      { provider: params.provider },
    );
  }

  const model = (params.request.model ?? params.model)?.trim();
  if (!model) {
    throw new LlmHttpError(
      `Missing model for ${params.provider}: set ${params.modelEnvVar ?? 'PREFLIGHT_MODEL'} or pass model`,
      { provider: params.provider },
    );
  }

  if (
    params.timeoutMs !== undefined &&
    (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0)
  ) {
    throw new LlmHttpError('timeoutMs must be a positive finite number', {
      provider: params.provider,
    });
  }

  const url = `${baseUrl}/chat/completions`;
  const fetchImpl: FetchLike = params.fetch ?? globalThis.fetch;
  const queue = params.queue ?? sharedSingleFlightQueue;

  const maxRetries = Math.max(0, params.retry?.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelayMs = Math.max(0, params.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, params.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const sleep = params.retry?.sleep ?? defaultSleep;
  const random = params.retry?.random ?? Math.random;

  const payload: Record<string, unknown> = {
    model,
    messages: params.request.messages,
  };

  if (params.request.max_completion_tokens !== undefined) {
    payload.max_completion_tokens = params.request.max_completion_tokens;
  }
  if (params.request.temperature !== undefined) {
    payload.temperature = params.request.temperature;
  }
  if (params.request.reasoning_effort !== undefined) {
    payload.reasoning_effort = params.request.reasoning_effort;
  }
  if (params.request.reasoning_format !== undefined) {
    payload.reasoning_format = params.request.reasoning_format;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify(payload);
  const secrets = apiKey ? [apiKey] : [];

  return queue.enqueue(async () => {
    const startMs = performance.now();
    const requestSignal = createRequestSignal(params.timeoutMs, params.request.signal);

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let response: Response;
        try {
          const init: RequestInit = {
            method: 'POST',
            headers,
            body,
          };
          if (requestSignal.signal !== undefined) {
            init.signal = requestSignal.signal;
          }
          response = await fetchImpl(url, init);
        } catch (error) {
          if (requestSignal.didTimeout()) {
            throw new LlmHttpError(
              `${params.provider} request timed out after ${params.timeoutMs}ms`,
              { provider: params.provider },
            );
          }
          const rawMessage = error instanceof Error ? error.message : String(error);
          const safeMessage = redactSecrets(rawMessage, secrets);
          throw new LlmHttpError(
            `${params.provider} request failed: ${safeMessage}`,
            { provider: params.provider },
          );
        }

        if (response.status === 429) {
          const rawBody = await response.text().catch(() => '');
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

          if (attempt < maxRetries) {
            const delayMs = computeRetryDelayMs(attempt, retryAfterMs, {
              baseDelayMs,
              maxDelayMs,
              random,
            });
            try {
              await sleep(delayMs, requestSignal.signal);
            } catch (error) {
              if (requestSignal.didTimeout()) {
                throw new LlmHttpError(
                  `${params.provider} request timed out after ${params.timeoutMs}ms`,
                  { provider: params.provider },
                );
              }
              throw error;
            }
            continue;
          }

          const safeBody = redactSecrets(truncateSnippet(rawBody), secrets);
          const detail = safeBody ? `: ${safeBody}` : '';
          throw new LlmHttpError(
            `${params.provider} rate limited (HTTP 429) after ${maxRetries} retries${detail}`,
            {
              provider: params.provider,
              status: 429,
              retryAfterMs,
            },
          );
        }

        const rawText = await response.text().catch(() => '');

        if (!response.ok) {
          const safeBody = redactSecrets(truncateSnippet(rawText), secrets);
          const detail = safeBody ? `: ${safeBody}` : '';
          throw new LlmHttpError(
            `${params.provider} API error (HTTP ${response.status})${detail}`,
            {
              provider: params.provider,
              status: response.status,
            },
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          const safeSnippet = redactSecrets(truncateSnippet(rawText), secrets);
          throw new LlmHttpError(
            `${params.provider} returned invalid JSON (HTTP ${response.status}): ${safeSnippet}`,
            {
              provider: params.provider,
              status: response.status,
            },
          );
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new LlmHttpError(
            `${params.provider} returned unexpected JSON response shape (HTTP ${response.status})`,
            {
              provider: params.provider,
              status: response.status,
            },
          );
        }

        const raw = parsed as RawChatCompletionResponse;
        const wallTimeMs = Math.max(0, performance.now() - startMs);

        return {
          raw,
          time_info: raw.time_info ?? null,
          usage: raw.usage ?? null,
          wallTimeMs,
          status: response.status,
        };
      }

      throw new LlmHttpError(`${params.provider} request failed unexpectedly`, {
        provider: params.provider,
      });
    } finally {
      requestSignal.cleanup();
    }
  });
}
