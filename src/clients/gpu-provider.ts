import { normalizeBaseUrl, postChatCompletion, type SingleFlightQueue } from './http.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  FetchLike,
  LlmClient,
  RetryOptions,
} from './types.js';

export const DEFAULT_MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

export interface GpuProviderClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  queue?: SingleFlightQueue;
  retry?: RetryOptions;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Thin OpenAI-compatible client for Moonshot's Kimi GPU API (comparison provider).
 */
export class GpuProviderClient implements LlmClient {
  readonly provider = 'moonshot';
  readonly baseUrl: string;
  readonly model: string;

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly queue: SingleFlightQueue | undefined;
  private readonly retry: RetryOptions | undefined;

  constructor(options: GpuProviderClientOptions = {}) {
    const env = options.env ?? process.env;
    this.apiKey = options.apiKey ?? env.MOONSHOT_API_KEY;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? env.MOONSHOT_BASE_URL ?? DEFAULT_MOONSHOT_BASE_URL,
    );
    this.model = options.model ?? env.MOONSHOT_MODEL ?? '';
    this.fetchImpl = options.fetch;
    this.queue = options.queue;
    this.retry = options.retry;
  }

  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return postChatCompletion({
      provider: this.provider,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      apiKeyEnvVar: 'MOONSHOT_API_KEY',
      model: this.model,
      modelEnvVar: 'MOONSHOT_MODEL',
      request,
      fetch: this.fetchImpl,
      queue: this.queue,
      retry: this.retry,
    });
  }
}
