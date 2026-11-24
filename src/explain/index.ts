import { performance } from 'node:perf_hooks';
import { redactSecrets } from '../clients/http.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatCompletionUsage,
  ChatMessage,
  LlmClient,
  ProviderTimeInfo,
} from '../clients/types.js';
import {
  buildBudgetedContext,
  DEFAULT_MAX_INPUT_TOKENS,
  gatherContext,
  loadWorkflowCommands,
  type GatherOptions,
  type WorkflowCommand,
} from '../gather/index.js';
import { computeTelemetry, formatSpeedPanel } from '../telemetry/index.js';
import {
  runVerify,
  type VerifyOptions,
  type VerifyResult,
} from '../verify/index.js';
import { loadCiLog } from './log-loader.js';
import { validateExplainOutput } from './schema.js';
import {
  ExplainValidationError,
  type ExplainClientMeta,
  type ExplainOptions,
  type ExplainOutput,
  type ExplainResult,
} from './types.js';

export const DEFAULT_EXPLAIN_MAX_COMPLETION_TOKENS = 1500;
export const DEFAULT_EXPLAIN_REASONING_EFFORT = 'low';

const MAX_HEADER_ITEMS = 50;
const MAX_FAILURE_EXCERPT_CHARS = 600;

const EXAMPLE_EXPLAIN_OUTPUT = JSON.stringify(
  {
    root_cause:
      'TypeScript typecheck failed in src/clients/http.ts:42 because retryAfterMs can be null.',
    failing_command: 'npm run typecheck',
    suggested_patch: [
      '--- a/src/clients/http.ts',
      '+++ b/src/clients/http.ts',
      '@@ -40,3 +40,3 @@',
      '-  return retryAfterMs + 100;',
      '+  return (retryAfterMs ?? 0) + 100;',
    ].join('\n'),
    explanation:
      'parseRetryAfterMs returns number | null, so adding 100 directly fails strict null checks. Defaulting null to 0 resolves the type error.',
  },
  null,
  2,
);

const EXPLAIN_SYSTEM_PROMPT = [
  'You are Preflight, a fast CI failure root-cause analyst.',
  'Inspect the failing CI log along with any repository diff, changed files, and CI workflow commands. Identify the exact root cause, the failing CI command, a concise suggested patch, and a clear explanation.',
  '',
  'STRICT OUTPUT CONTRACT:',
  '- Return ONLY a single raw JSON object. Do NOT output prose, commentary, or markdown code fences (no ```json or ```).',
  '- Top-level JSON object MUST contain these exact required fields:',
  '  - "root_cause": non-empty string summarizing the specific root cause of the CI failure.',
  '  - "failing_command": non-empty string with the failing CI command derived ONLY from the provided CI workflow commands (or a safe scoped variant using the exact same tool and subcommand, with no shell chaining/metacharacters), or null if no runnable command can be identified.',
  '  - "suggested_patch": non-empty string with a concrete unified diff or actionable patch that fixes the failure.',
  '  - "explanation": non-empty string explaining why the failure happened and how the patch addresses it.',
  '',
  'COMMAND SAFETY RULES:',
  '- Never invent unrelated shell commands or shell chaining/redirection (never use ";", "&&", "||", "|", backticks, "$(...)", ">", "<", or ".." path traversal).',
  '- If no allowlisted CI workflow command corresponds to the failure, set "failing_command" to null.',
  '',
  'EXAMPLE JSON OUTPUT:',
  EXAMPLE_EXPLAIN_OUTPUT,
].join('\n');

export interface ExplainPromptInput {
  source: string;
  budgetedContext: string;
  workflowCommands: readonly WorkflowCommand[];
  changedFiles: readonly string[];
}

function formatChangedFilesHeader(changedFiles: readonly string[]): string | null {
  if (changedFiles.length === 0) {
    return null;
  }

  const displayed = changedFiles.slice(0, MAX_HEADER_ITEMS);
  const lines = ['Changed files:', ...displayed.map((file) => `- ${file}`)];
  if (changedFiles.length > MAX_HEADER_ITEMS) {
    lines.push(`- ... (+${changedFiles.length - MAX_HEADER_ITEMS} more)`);
  }
  return lines.join('\n');
}

function formatWorkflowCommandsHeader(
  workflowCommands: readonly WorkflowCommand[],
): string | null {
  if (workflowCommands.length === 0) {
    return null;
  }

  const displayed = workflowCommands.slice(0, MAX_HEADER_ITEMS);
  const lines = [
    'Allowed CI workflow commands (set failing_command ONLY from these or null):',
    ...displayed.map((entry) => `- [${entry.job}] (${entry.file}): ${entry.command}`),
  ];
  if (workflowCommands.length > MAX_HEADER_ITEMS) {
    lines.push(`- ... (+${workflowCommands.length - MAX_HEADER_ITEMS} more)`);
  }
  return lines.join('\n');
}

export function buildExplainMessages(input: ExplainPromptInput): ChatMessage[] {
  const userSections: string[] = [`CI log source: ${redactSecrets(input.source)}`];

  const changedFilesSection = formatChangedFilesHeader(input.changedFiles);
  if (changedFilesSection !== null) {
    userSections.push(changedFilesSection);
  }

  const workflowCommandsSection = formatWorkflowCommandsHeader(input.workflowCommands);
  if (workflowCommandsSection !== null) {
    userSections.push(workflowCommandsSection);
  }

  userSections.push(
    'Budgeted CI failure and repository context:',
    input.budgetedContext,
    'Respond with ONLY a valid raw JSON object matching the required schema.',
  );

  return [
    { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
    { role: 'user', content: userSections.join('\n\n') },
  ];
}

export function buildExplainRetryMessages(
  originalMessages: readonly ChatMessage[],
  badOutput: string,
  errors: readonly string[],
): ChatMessage[] {
  const errorLines =
    errors.length > 0
      ? errors.map((err) => `- ${err}`).join('\n')
      : '- Output did not conform to the required ExplainOutput JSON schema.';

  const assistantOutput =
    badOutput.trim().length > 0 ? badOutput : '(empty response)';

  const correctionMessage = [
    'Your previous response failed JSON validation with the following error(s):',
    errorLines,
    '',
    'Fix these errors and return ONLY a single valid raw JSON object with required fields:',
    '"root_cause" (non-empty string), "failing_command" (non-empty string or null), "suggested_patch" (non-empty string), and "explanation" (non-empty string).',
    'Do not include any prose or markdown code fences.',
  ].join('\n');

  return [
    ...originalMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: 'assistant', content: assistantOutput },
    { role: 'user', content: correctionMessage },
  ];
}

function buildExplainCompletionRequest(
  messages: ChatMessage[],
  options: ExplainOptions,
): ChatCompletionRequest {
  const request: ChatCompletionRequest = {
    messages,
    max_completion_tokens:
      options.maxCompletionTokens ?? DEFAULT_EXPLAIN_MAX_COMPLETION_TOKENS,
  };

  if (options.think === true) {
    request.reasoning_effort = DEFAULT_EXPLAIN_REASONING_EFFORT;
    request.reasoning_format = 'parsed';
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

function evaluateExplainResponse(response: ChatCompletionResult):
  | { ok: true; output: ExplainOutput; rawContent: string }
  | { ok: false; errors: string[]; rawContent: string } {
  const { content, missing } = extractRawContent(response);
  if (missing) {
    return {
      ok: false,
      errors: ['LLM response missing choices[0].message.content'],
      rawContent: '',
    };
  }

  const validation = validateExplainOutput(content);
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
  first: ChatCompletionUsage | null,
  second: ChatCompletionUsage | null,
): ChatCompletionUsage | null {
  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }

  const merged: ChatCompletionUsage = {};
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

function gatherExplainContext(
  options: ExplainOptions,
  recentCiLog: string,
): {
  budgetedContext: string;
  workflowCommands: WorkflowCommand[];
  changedFiles: string[];
} {
  const gatherOptions: GatherOptions = {
    cwd: options.cwd,
    recentCiLog,
  };
  if (options.baseRef !== undefined) {
    gatherOptions.baseRef = options.baseRef;
  }
  if (options.maxInputTokens !== undefined) {
    gatherOptions.maxInputTokens = options.maxInputTokens;
  }
  if (options.gitExec !== undefined) {
    gatherOptions.gitExec = options.gitExec;
  }

  try {
    const gathered = gatherContext(gatherOptions);
    return {
      budgetedContext: gathered.budgetedContext,
      workflowCommands: gathered.workflowCommands,
      changedFiles: gathered.changedFiles,
    };
  } catch {
    // Graceful fallback when cwd is not a git repo or has no resolvable base ref.
    const workflowCommands = loadWorkflowCommands(options.cwd);
    const budgeted = buildBudgetedContext(
      {
        baseRef: options.baseRef ?? 'unavailable',
        diff: '',
        changedFiles: [],
        workflowCommands,
        affectedTests: [],
        changedFileContents: [],
        neighborContents: [],
        recentCiLog,
      },
      options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    );

    return {
      budgetedContext: budgeted.budgetedContext,
      workflowCommands,
      changedFiles: [],
    };
  }
}

/**
 * Runs Stage 4 (Explain): loads a CI failure log (local file or GitHub Actions URL),
 * gathers repository context (falling back gracefully to log-only context), prompts
 * the configured LLM for a validated JSON diagnosis (retrying at most once), optionally
 * reproduces an allowlisted failing command locally, and returns Speed & Telemetry data.
 */
export async function runExplain(
  options: ExplainOptions,
  client: LlmClient,
  clientMeta: ExplainClientMeta,
): Promise<ExplainResult> {
  if (
    options.maxCompletionTokens !== undefined &&
    (!Number.isInteger(options.maxCompletionTokens) || options.maxCompletionTokens <= 0)
  ) {
    throw new RangeError('maxCompletionTokens must be a positive integer');
  }

  const totalStartMs = performance.now();

  const gatherStartMs = performance.now();
  const recentCiLog = loadCiLog(options.source, {
    cwd: options.cwd,
    readFileFn: options.readFileFn,
    fetchGitHubLogFn: options.fetchGitHubLogFn,
  });
  const context = gatherExplainContext(options, recentCiLog);
  const gatherMs = Math.max(0, performance.now() - gatherStartMs);

  const thinkStartMs = performance.now();
  const initialMessages = buildExplainMessages({
    source: options.source,
    budgetedContext: context.budgetedContext,
    workflowCommands: context.workflowCommands,
    changedFiles: context.changedFiles,
  });

  const firstResponse = await client.chatCompletion(
    buildExplainCompletionRequest(initialMessages, options),
  );
  const firstEvaluation = evaluateExplainResponse(firstResponse);

  let output: ExplainOutput;
  let attempts: 1 | 2;
  let usage: ChatCompletionUsage | null;
  let timeInfo: ProviderTimeInfo | null;
  let llmWallTimeMs: number;

  if (firstEvaluation.ok) {
    output = firstEvaluation.output;
    attempts = 1;
    usage = firstResponse.usage;
    timeInfo = firstResponse.time_info;
    llmWallTimeMs = firstResponse.wallTimeMs;
  } else {
    const retryMessages = buildExplainRetryMessages(
      initialMessages,
      firstEvaluation.rawContent,
      firstEvaluation.errors,
    );
    const secondResponse = await client.chatCompletion(
      buildExplainCompletionRequest(retryMessages, options),
    );
    const secondEvaluation = evaluateExplainResponse(secondResponse);

    if (!secondEvaluation.ok) {
      throw new ExplainValidationError(
        `Explain stage output failed validation after 2 attempts: ${secondEvaluation.errors.join('; ')}`,
        {
          attempts: 2,
          validationErrors: secondEvaluation.errors,
          lastRawContent: secondEvaluation.rawContent,
        },
      );
    }

    output = secondEvaluation.output;
    attempts = 2;
    usage = mergeUsage(firstResponse.usage, secondResponse.usage);
    timeInfo = mergeTimeInfo(firstResponse.time_info, secondResponse.time_info);
    llmWallTimeMs = firstResponse.wallTimeMs + secondResponse.wallTimeMs;
  }

  const measuredThinkMs = Math.max(0, performance.now() - thinkStartMs);
  const thinkMs = llmWallTimeMs > 0 ? llmWallTimeMs : measuredThinkMs;

  let verification: VerifyResult | null = null;
  let verifyMs = 0;

  if (
    options.verify !== false &&
    output.failing_command !== null &&
    output.failing_command.trim().length > 0 &&
    context.workflowCommands.length > 0
  ) {
    const verifyStartMs = performance.now();
    const verifyOptions: VerifyOptions = { cwd: options.cwd };
    if (options.timeoutMs !== undefined) {
      verifyOptions.timeoutMs = options.timeoutMs;
    }
    if (options.spawnCommand !== undefined) {
      verifyOptions.spawnCommand = options.spawnCommand;
    }
    verification = await runVerify(
      [output.failing_command],
      context.workflowCommands,
      verifyOptions,
    );
    verifyMs = Math.max(0, performance.now() - verifyStartMs);
  }

  const measuredTotalMs = Math.max(0, performance.now() - totalStartMs);
  const totalWallMs = Math.max(measuredTotalMs, gatherMs + thinkMs + verifyMs);

  const telemetry = computeTelemetry({
    provider: clientMeta.provider,
    model: clientMeta.model,
    base_url: clientMeta.baseUrl,
    usage,
    time_info: timeInfo,
    timing_ms: {
      gather_ms: gatherMs,
      think_ms: thinkMs,
      verify_ms: verifyMs,
      total_wall_ms: totalWallMs,
    },
  });

  return {
    source: options.source,
    output,
    attempts,
    verification,
    telemetry,
  };
}

function indentLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function extractFailureExcerpt(stderr: string, stdout: string): string | null {
  const combined = stderr.trim().length > 0 ? stderr.trim() : stdout.trim();
  if (combined.length === 0) {
    return null;
  }
  if (combined.length <= MAX_FAILURE_EXCERPT_CHARS) {
    return combined;
  }
  return `...${combined.slice(combined.length - MAX_FAILURE_EXCERPT_CHARS)}`;
}

/**
 * Formats an ExplainResult into a human-readable terminal report including root cause,
 * explanation, failing command, suggested patch, exit-code-only verification status,
 * and the Speed & Telemetry panel.
 */
export function formatExplainReport(result: ExplainResult): string {
  const sections: string[] = [
    `Preflight Explain (${result.source})`,
    '',
    'Root Cause:',
    indentLines(result.output.root_cause, '  '),
    '',
    'Explanation:',
    indentLines(result.output.explanation, '  '),
    '',
    `Failing Command: ${result.output.failing_command ?? '(none identified)'}`,
    '',
    'Suggested Patch:',
    indentLines(result.output.suggested_patch, '  '),
  ];

  if (result.verification !== null) {
    sections.push('', `Local Verification: ${result.verification.verdictMessage}`);
    for (const item of result.verification.results) {
      if (item.status === 'refused') {
        const reason = item.refusalReason ?? 'command is not allowlisted';
        sections.push(`  - [refused] ${item.command} (${reason})`);
        continue;
      }

      const exitLabel = item.exitCode !== null ? `exit ${item.exitCode}` : 'no exit code';
      sections.push(`  - [${item.status}] ${item.command} (${exitLabel}, ${item.durationMs}ms)`);

      if (item.status === 'failed' || item.status === 'timed_out') {
        const excerpt = extractFailureExcerpt(item.stderr, item.stdout);
        if (excerpt !== null) {
          sections.push(indentLines(excerpt, '    '));
        }
      }
    }
  } else {
    sections.push('', 'Local Verification: skipped');
  }

  sections.push('', formatSpeedPanel(result.telemetry));

  return redactSecrets(sections.join('\n'));
}

export {
  boundLogTail,
  DEFAULT_MAX_LOG_CHARS,
  loadCiLog,
  parseGitHubActionsUrl,
  selectFirstFailedJobId,
  stripAnsi,
} from './log-loader.js';
export { extractJsonText, validateExplainOutput } from './schema.js';
export {
  ExplainValidationError,
  type ExplainClientMeta,
  type ExplainOptions,
  type ExplainOutput,
  type ExplainResult,
  type ExplainValidationResult,
  type GitHubLogTarget,
  type LoadCiLogOptions,
} from './types.js';
