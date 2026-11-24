import type { ChatCompletionUsage, ProviderTimeInfo } from '../clients/types.js';

export type TokenUsage = ChatCompletionUsage;

export interface LikelyFailure {
  category: string;
  target: string;
  reason: string;
  file?: string;
  line?: number;
  confidence?: number;
}

export interface ThinkOutput {
  likely_failures: LikelyFailure[];
  affected_jobs: string[];
  commands: string[];
  notes: string;
}

export interface ThinkWorkflowCommand {
  file: string;
  job: string;
  command: string;
  stepName?: string;
  workingDirectory?: string;
}

export interface ThinkInput {
  budgetedContext: string;
  workflowCommands: readonly ThinkWorkflowCommand[];
  changedFiles: readonly string[];
}

export interface ThinkOptions {
  /** Maximum completion tokens requested from the LLM. Default: 1500. */
  maxCompletionTokens?: number;
  /** Enable model reasoning mode (opt-in via --think). Default: false. */
  think?: boolean;
  /** Reasoning effort level used when `think` is true. Default: 'low'. */
  reasoningEffort?: string;
  /** Optional model override forwarded to the LLM client. */
  model?: string;
  /** Optional sampling temperature forwarded to the LLM client. */
  temperature?: number;
  /** Optional AbortSignal to cancel the LLM request. */
  signal?: AbortSignal;
}

export interface ThinkResult {
  output: ThinkOutput;
  attempts: 1 | 2;
  usage: TokenUsage | null;
  timeInfo: ProviderTimeInfo | null;
  wallTimeMs: number;
  rawContent: string;
}

export type ThinkValidationResult =
  | { ok: true; value: ThinkOutput }
  | { ok: false; errors: string[] };

export class ThinkValidationError extends Error {
  readonly attempts: number;
  readonly validationErrors: string[];
  readonly lastRawContent: string;

  constructor(
    message: string,
    options: {
      attempts: number;
      validationErrors: readonly string[];
      lastRawContent: string;
    },
  ) {
    super(message);
    this.name = 'ThinkValidationError';
    this.attempts = options.attempts;
    this.validationErrors = [...options.validationErrors];
    this.lastRawContent = options.lastRawContent;
  }
}
