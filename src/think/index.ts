import { supportsReasoningFormat } from '../clients/http.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  LlmClient,
  ProviderTimeInfo,
} from '../clients/types.js';
import { buildRetryMessages, buildThinkMessages } from './prompt.js';
import { validateThinkOutput } from './schema.js';
import {
  ThinkValidationError,
  type ThinkInput,
  type ThinkOptions,
  type ThinkResult,
  type TokenUsage,
} from './types.js';

export const DEFAULT_MAX_COMPLETION_TOKENS = 1500;
export const DEFAULT_REASONING_EFFORT = 'low';

function buildCompletionRequest(
  messages: ChatMessage[],
  options: ThinkOptions | undefined,
  provider: string,
): ChatCompletionRequest {
  const maxCompletionTokens =
    options?.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;

  const request: ChatCompletionRequest = {
    messages,
    max_completion_tokens: maxCompletionTokens,
  };

  if (options?.model !== undefined) {
    request.model = options.model;
  }

  if (options?.temperature !== undefined) {
    request.temperature = options.temperature;
  }

  if (options?.think === true) {
    const customEffort = options.reasoningEffort?.trim();
    request.reasoning_effort =
      customEffort && customEffort.length > 0
        ? customEffort
        : DEFAULT_REASONING_EFFORT;
    if (supportsReasoningFormat(provider)) {
      request.reasoning_format = 'parsed';
    }
  }

  if (options?.signal !== undefined) {
    request.signal = options.signal;
  }

  return request;
}

function extractRawContent(response: ChatCompletionResult): {
  content: string;
  missing: boolean;
} {
  const content = response.raw.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return { content: '', missing: true };
  }
  return { content, missing: false };
}

function sumFiniteNumbers(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  const hasFirst = typeof first === 'number' && Number.isFinite(first);
  const hasSecond = typeof second === 'number' && Number.isFinite(second);
  if (hasFirst && hasSecond) {
    return first + second;
  }
  if (hasFirst) {
    return first;
  }
  if (hasSecond) {
    return second;
  }
  return undefined;
}

function mergeUsage(
  first: TokenUsage | null,
  second: TokenUsage | null,
): TokenUsage | null {
  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }

  const merged: TokenUsage = {};
  const promptTokens = sumFiniteNumbers(first.prompt_tokens, second.prompt_tokens);
  const completionTokens = sumFiniteNumbers(
    first.completion_tokens,
    second.completion_tokens,
  );
  const totalTokens = sumFiniteNumbers(first.total_tokens, second.total_tokens);

  if (promptTokens !== undefined) {
    merged.prompt_tokens = promptTokens;
  }
  if (completionTokens !== undefined) {
    merged.completion_tokens = completionTokens;
  }
  if (totalTokens !== undefined) {
    merged.total_tokens = totalTokens;
  }

  return merged;
}

function mergeTimeInfo(
  first: ProviderTimeInfo | null,
  second: ProviderTimeInfo | null,
): ProviderTimeInfo | null {
  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }

  const merged: ProviderTimeInfo = {};
  const queueTime = sumFiniteNumbers(first.queue_time, second.queue_time);
  const promptTime = sumFiniteNumbers(first.prompt_time, second.prompt_time);
  const completionTime = sumFiniteNumbers(
    first.completion_time,
    second.completion_time,
  );
  const totalTime = sumFiniteNumbers(first.total_time, second.total_time);

  if (queueTime !== undefined) {
    merged.queue_time = queueTime;
  }
  if (promptTime !== undefined) {
    merged.prompt_time = promptTime;
  }
  if (completionTime !== undefined) {
    merged.completion_time = completionTime;
  }
  if (totalTime !== undefined) {
    merged.total_time = totalTime;
  }
  if (second.created !== undefined) {
    merged.created = second.created;
  } else if (first.created !== undefined) {
    merged.created = first.created;
  }

  return merged;
}

function evaluateResponse(response: ChatCompletionResult):
  | { ok: true; output: ThinkResult['output']; rawContent: string }
  | { ok: false; errors: string[]; rawContent: string } {
  const { content, missing } = extractRawContent(response);
  if (missing) {
    return {
      ok: false,
      errors: ['LLM response missing choices[0].message.content'],
      rawContent: '',
    };
  }

  const validation = validateThinkOutput(content);
  if (validation.ok) {
    return {
      ok: true,
      output: validation.value,
      rawContent: content,
    };
  }

  return {
    ok: false,
    errors: validation.errors,
    rawContent: content,
  };
}

/**
 * Runs Stage 2 (Think): sends budgeted repository context to the configured
 * OpenAI-compatible LLM client, validates the plain-text JSON output, and
 * performs at most one error-feedback retry on parse or schema failure.
 */
export async function runThink(
  input: ThinkInput,
  client: LlmClient,
  options?: ThinkOptions,
): Promise<ThinkResult> {
  if (
    options?.maxCompletionTokens !== undefined &&
    (!Number.isInteger(options.maxCompletionTokens) || options.maxCompletionTokens <= 0)
  ) {
    throw new RangeError('maxCompletionTokens must be a positive integer');
  }

  const initialMessages = buildThinkMessages(input);
  const firstResponse = await client.chatCompletion(
    buildCompletionRequest(initialMessages, options, client.provider),
  );
  const firstEvaluation = evaluateResponse(firstResponse);

  if (firstEvaluation.ok) {
    return {
      output: firstEvaluation.output,
      attempts: 1,
      usage: firstResponse.usage,
      timeInfo: firstResponse.time_info,
      wallTimeMs: firstResponse.wallTimeMs,
      rawContent: firstEvaluation.rawContent,
    };
  }

  const retryMessages = buildRetryMessages(
    initialMessages,
    firstEvaluation.rawContent,
    firstEvaluation.errors,
  );
  const secondResponse = await client.chatCompletion(
    buildCompletionRequest(retryMessages, options, client.provider),
  );
  const secondEvaluation = evaluateResponse(secondResponse);

  if (secondEvaluation.ok) {
    return {
      output: secondEvaluation.output,
      attempts: 2,
      usage: mergeUsage(firstResponse.usage, secondResponse.usage),
      timeInfo: mergeTimeInfo(firstResponse.time_info, secondResponse.time_info),
      wallTimeMs: firstResponse.wallTimeMs + secondResponse.wallTimeMs,
      rawContent: secondEvaluation.rawContent,
    };
  }

  throw new ThinkValidationError(
    `Think stage output failed validation after 2 attempts: ${secondEvaluation.errors.join('; ')}`,
    {
      attempts: 2,
      validationErrors: secondEvaluation.errors,
      lastRawContent: secondEvaluation.rawContent,
    },
  );
}

export { buildRetryMessages, buildThinkMessages } from './prompt.js';
export { extractJsonText, validateThinkOutput } from './schema.js';
export {
  ThinkValidationError,
  type LikelyFailure,
  type ThinkInput,
  type ThinkOptions,
  type ThinkOutput,
  type ThinkResult,
  type ThinkValidationResult,
  type ThinkWorkflowCommand,
  type TokenUsage,
} from './types.js';
