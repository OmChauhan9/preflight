export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  max_completion_tokens?: number;
  temperature?: number;
  /**
   * Reasoning effort setting (e.g. "low" | "medium" | "high" | "none").
   * Omitted from the wire payload when undefined so reasoning stays off by default.
   */
  reasoning_effort?: string;
  /** Optional reasoning format (e.g. "parsed") when supported by provider. */
  reasoning_format?: string;
  signal?: AbortSignal;
}

export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface CerebrasTimeInfo {
  queue_time?: number;
  prompt_time?: number;
  completion_time?: number;
  total_time?: number;
  created?: number;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    [key: string]: unknown;
  };
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface RawChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  time_info?: CerebrasTimeInfo | null;
  [key: string]: unknown;
}

export interface ChatCompletionResult {
  raw: RawChatCompletionResponse;
  time_info: CerebrasTimeInfo | null;
  usage: ChatCompletionUsage | null;
  wallTimeMs: number;
  status: number;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryOptions {
  /** Maximum number of retries on HTTP 429 after the initial attempt. Default: 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 500. */
  baseDelayMs?: number;
  /** Maximum retry delay in ms (bounds both Retry-After and exponential backoff). Default: 10000. */
  maxDelayMs?: number;
  /** Injectable sleep helper for deterministic tests. */
  sleep?: SleepFn;
  /** Injectable random number generator returning [0, 1) for deterministic jitter tests. */
  random?: () => number;
}

export interface LlmClient {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}
