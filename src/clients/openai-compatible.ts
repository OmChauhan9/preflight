import { postChatCompletion, type SingleFlightQueue } from './http.js';
import {
  resolveProviderConfig,
  type EnvSource,
  type ProviderName,
} from './providers.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  FetchLike,
  LlmClient,
  RetryOptions,
  SleepFn,
} from './types.js';

export interface OpenAICompatibleClientOptions {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  env?: EnvSource;
  fetch?: FetchLike;
  sleep?: SleepFn;
  random?: () => number;
  singleFlightQueue?: SingleFlightQueue;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Provider-agnostic OpenAI-compatible Chat Completions client.
 * Defaults to local Ollama (`http://localhost:11434/v1`) with zero API keys required.
 */
export class OpenAICompatibleClient implements LlmClient {
  readonly provider: ProviderName;
  readonly baseUrl: string;
  readonly model: string;

  readonly #apiKey: string | undefined;
  readonly #requiresApiKey: boolean;
  readonly #apiKeyEnvVar: string;
  readonly #fetchImpl: FetchLike | undefined;
  readonly #singleFlightQueue: SingleFlightQueue | undefined;
  readonly #retryOptions: RetryOptions;
  readonly #timeoutMs: number | undefined;

  constructor(options: OpenAICompatibleClientOptions = {}) {
    const resolved = resolveProviderConfig(
      {
        provider: options.provider,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
      },
      options.env,
    );

    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new Error('timeoutMs must be a positive finite number.');
    }

    this.provider = resolved.provider;
    this.baseUrl = resolved.baseUrl;
    this.model = resolved.model;
    this.#apiKey = resolved.apiKey;
    this.#requiresApiKey = resolved.preset.requiresApiKey;
    this.#apiKeyEnvVar = resolved.preset.apiKeyEnv;
    this.#fetchImpl = options.fetch;
    this.#singleFlightQueue = options.singleFlightQueue;
    this.#timeoutMs = options.timeoutMs;
    this.#retryOptions = {
      maxRetries: options.maxRetries,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      sleep: options.sleep,
      random: options.random,
    };
  }

  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return postChatCompletion({
      provider: this.provider,
      baseUrl: this.baseUrl,
      apiKey: this.#apiKey,
      requiresApiKey: this.#requiresApiKey,
      apiKeyEnvVar: this.#apiKeyEnvVar,
      model: this.model,
      modelEnvVar: 'PREFLIGHT_MODEL',
      request,
      fetch: this.#fetchImpl,
      queue: this.#singleFlightQueue,
      retry: this.#retryOptions,
      timeoutMs: this.#timeoutMs,
    });
  }
}

/**
 * Convenience factory creating an `OpenAICompatibleClient` from environment
 * variables (`PREFLIGHT_PROVIDER`, `PREFLIGHT_MODEL`, `PREFLIGHT_BASE_URL`,
 * `PREFLIGHT_API_KEY`, and provider-specific key fallbacks) with optional overrides.
 */
export function createClientFromEnv(
  options: OpenAICompatibleClientOptions = {},
): OpenAICompatibleClient {
  return new OpenAICompatibleClient(options);
}
