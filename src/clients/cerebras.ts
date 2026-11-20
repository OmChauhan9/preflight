import { normalizeBaseUrl, postChatCompletion, type SingleFlightQueue } from './http.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  FetchLike,
  LlmClient,
  RetryOptions,
} from './types.js';

export const DEFAULT_CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
export const DEFAULT_CEREBRAS_MODEL = 'moonshotai-kimi-k3.1-pro-trial';

export interface CerebrasClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  queue?: SingleFlightQueue;
  retry?: RetryOptions;
  env?: Readonly<Record<string, string | undefined>>;
}

export class CerebrasClient implements LlmClient {
  readonly provider = 'cerebras';
  readonly baseUrl: string;
  readonly model: string;

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly queue: SingleFlightQueue | undefined;
  private readonly retry: RetryOptions | undefined;

  constructor(options: CerebrasClientOptions = {}) {
    const env = options.env ?? process.env;
    this.apiKey = options.apiKey ?? env.CEREBRAS_API_KEY;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? env.CEREBRAS_BASE_URL ?? DEFAULT_CEREBRAS_BASE_URL,
    );
    this.model = options.model ?? env.CEREBRAS_MODEL ?? DEFAULT_CEREBRAS_MODEL;
    this.fetchImpl = options.fetch;
    this.queue = options.queue;
    this.retry = options.retry;
  }

  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return postChatCompletion({
      provider: this.provider,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      apiKeyEnvVar: 'CEREBRAS_API_KEY',
      model: this.model,
      modelEnvVar: 'CEREBRAS_MODEL',
      request,
      fetch: this.fetchImpl,
      queue: this.queue,
      retry: this.retry,
    });
  }
}
