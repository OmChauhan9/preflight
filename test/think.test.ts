import { describe, expect, it } from 'vitest';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatCompletionUsage,
  LlmClient,
  ProviderTimeInfo,
} from '../src/clients/types.js';
import {
  buildRetryMessages,
  buildThinkMessages,
  DEFAULT_MAX_COMPLETION_TOKENS,
  extractJsonText,
  runThink,
  ThinkValidationError,
  validateThinkOutput,
  type ThinkInput,
  type ThinkOutput,
} from '../src/think/index.js';

const SAMPLE_INPUT: ThinkInput = {
  budgetedContext: [
    '## Git Diff',
    'diff --git a/src/clients/http.ts b/src/clients/http.ts',
    '--- a/src/clients/http.ts',
    '+++ b/src/clients/http.ts',
    '@@ -98,4 +98,4 @@',
    '-  return Math.ceil(seconds * 1000);',
    '+  return Math.floor(seconds * 1000);',
  ].join('\n'),
  workflowCommands: [
    { file: '.github/workflows/ci.yml', job: 'test', command: 'npm test' },
    { file: '.github/workflows/ci.yml', job: 'typecheck', command: 'npm run typecheck' },
    { file: '.github/workflows/ci.yml', job: 'lint', command: 'npm run lint' },
  ],
  changedFiles: ['src/clients/http.ts'],
};

const VALID_THINK_OUTPUT: ThinkOutput = {
  likely_failures: [
    {
      category: 'test',
      target: 'test/openai-compatible-client.test.ts',
      reason: 'Retry-After rounding changed in src/clients/http.ts',
      file: 'src/clients/http.ts',
      line: 114,
      confidence: 0.9,
    },
  ],
  affected_jobs: ['test', 'typecheck'],
  commands: ['npx vitest run test/openai-compatible-client.test.ts', 'npm run typecheck'],
  notes: 'Verify HTTP retry tests and typecheck after Retry-After change.',
};

interface MockResponseSpec {
  content?: string | null;
  omitChoices?: boolean;
  usage?: ChatCompletionUsage | null;
  timeInfo?: ProviderTimeInfo | null;
  wallTimeMs?: number;
}

function createMockResult(spec: MockResponseSpec): ChatCompletionResult {
  const usage = spec.usage === undefined ? { prompt_tokens: 400, completion_tokens: 90, total_tokens: 490 } : spec.usage;
  const timeInfo = spec.timeInfo === undefined ? null : spec.timeInfo;
  const wallTimeMs = spec.wallTimeMs ?? 125;

  return {
    raw: spec.omitChoices
      ? { id: 'chatcmpl-empty' }
      : {
          id: 'chatcmpl-mock',
          model: 'qwen2.5-coder:7b',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: spec.content,
              },
              finish_reason: 'stop',
            },
          ],
          usage: usage ?? undefined,
          time_info: timeInfo,
        },
    usage,
    time_info: timeInfo,
    wallTimeMs,
    status: 200,
  };
}

function createMockClient(
  responses: readonly (MockResponseSpec | Error)[],
  provider = 'ollama',
): { client: LlmClient; calls: ChatCompletionRequest[] } {
  const calls: ChatCompletionRequest[] = [];
  let index = 0;

  const client: LlmClient = {
    provider,
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b',
    chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
      calls.push(request);
      const next = responses[index];
      index += 1;
      if (next === undefined) {
        return Promise.reject(new Error(`Unexpected chatCompletion call #${index}`));
      }
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve(createMockResult(next));
    },
  };

  return { client, calls };
}

describe('extractJsonText', () => {
  it('trims surrounding whitespace from plain JSON', () => {
    const raw = '\n  {"likely_failures":[],"affected_jobs":[],"commands":[],"notes":"ok"}  \n';
    expect(extractJsonText(raw)).toBe(
      '{"likely_failures":[],"affected_jobs":[],"commands":[],"notes":"ok"}',
    );
  });

  it('extracts JSON wrapped in ```json and bare ``` markdown fences', () => {
    const jsonPayload = JSON.stringify(VALID_THINK_OUTPUT, null, 2);
    expect(extractJsonText(`\`\`\`json\n${jsonPayload}\n\`\`\``)).toBe(jsonPayload);
    expect(extractJsonText(`\`\`\`\n${jsonPayload}\n\`\`\``)).toBe(jsonPayload);
  });

  it('extracts JSON from a fenced block surrounded by minor prose', () => {
    const jsonPayload = JSON.stringify(VALID_THINK_OUTPUT);
    const wrapped = `Here is the Preflight analysis:\n\`\`\`json\n${jsonPayload}\n\`\`\`\nDone.`;
    expect(extractJsonText(wrapped)).toBe(jsonPayload);
  });

  it('extracts JSON from a single outer fence even when a string value contains triple backticks', () => {
    const jsonPayload = JSON.stringify({
      likely_failures: [],
      affected_jobs: [],
      commands: [],
      notes: 'Avoid ``` fences in output',
    });
    expect(extractJsonText(`\`\`\`json\n${jsonPayload}\n\`\`\``)).toBe(jsonPayload);
  });

  it('locates the outermost balanced JSON object surrounded by prose and stray braces', () => {
    const jsonPayload = JSON.stringify({
      likely_failures: [
        {
          category: 'test',
          target: 'test/a.test.ts',
          reason: 'Expected { ok: true } to match { ok: false } with } brace',
        },
      ],
      affected_jobs: ['test'],
      commands: ['npm test'],
      notes: 'Scoped test run',
    });
    const raw = `Note {meta}: here is the result:\n${jsonPayload}\n(format: {json})`;
    expect(extractJsonText(raw)).toBe(jsonPayload);
  });
});

describe('validateThinkOutput', () => {
  it('accepts valid ThinkOutput with optional fields and trims string fields', () => {
    const result = validateThinkOutput(JSON.stringify(VALID_THINK_OUTPUT));
    expect(result).toEqual({
      ok: true,
      value: VALID_THINK_OUTPUT,
    });
  });

  it('accepts empty arrays and empty notes string', () => {
    const minimal: ThinkOutput = {
      likely_failures: [],
      affected_jobs: [],
      commands: [],
      notes: '',
    };
    const result = validateThinkOutput(JSON.stringify(minimal));
    expect(result).toEqual({ ok: true, value: minimal });
  });

  it('returns clear parse errors for empty and malformed JSON', () => {
    const emptyResult = validateThinkOutput('   ');
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) {
      expect(emptyResult.errors[0]).toMatch(/empty response/i);
    }

    const malformed = validateThinkOutput('{"commands": [broken}');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.errors[0]).toMatch(/invalid JSON/i);
    }
  });

  it('rejects non-object top-level JSON values', () => {
    for (const raw of ['[]', '"hello"', '42', 'null']) {
      const result = validateThinkOutput(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContain('top-level JSON value must be an object');
      }
    }
  });

  it('reports all missing required top-level fields together', () => {
    const result = validateThinkOutput('{}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'missing required field: likely_failures',
        'missing required field: affected_jobs',
        'missing required field: commands',
        'missing required field: notes',
      ]);
    }
  });

  it('reports detailed element-level and optional-field validation errors', () => {
    const invalidPayload = {
      likely_failures: [
        'not-an-object',
        {
          category: '',
          target: 123,
          file: '   ',
          line: 0,
          confidence: 1.5,
        },
      ],
      affected_jobs: ['test', '   '],
      commands: [42, ''],
      notes: 99,
    };

    const result = validateThinkOutput(JSON.stringify(invalidPayload));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'likely_failures[0] must be an object',
        'likely_failures[1].category must be a non-empty string',
        'likely_failures[1].target must be a non-empty string',
        'likely_failures[1] missing required field: reason',
        'likely_failures[1].file must be a non-empty string',
        'likely_failures[1].line must be a positive integer',
        'likely_failures[1].confidence must be a number in [0, 1]',
        'affected_jobs[1] must be a non-empty string',
        'commands[0] must be a non-empty string',
        'commands[1] must be a non-empty string',
        'notes must be a string',
      ]);
    }
  });
});

describe('buildThinkMessages & buildRetryMessages', () => {
  it('builds system and user messages with strict JSON contract and embedded context', () => {
    const messages = buildThinkMessages(SAMPLE_INPUT);
    expect(messages).toHaveLength(2);

    const systemMsg = messages[0];
    const userMsg = messages[1];
    expect(systemMsg?.role).toBe('system');
    expect(systemMsg?.content).toContain('ONLY a single raw JSON object');
    expect(systemMsg?.content).toContain('likely_failures');
    expect(systemMsg?.content).toContain('affected_jobs');
    expect(systemMsg?.content).toContain('commands');
    expect(systemMsg?.content).toContain('notes');
    expect(systemMsg?.content).toContain('ONLY suggest scoped versions');

    expect(userMsg?.role).toBe('user');
    expect(userMsg?.content).toContain(SAMPLE_INPUT.budgetedContext);
    expect(userMsg?.content).toContain('src/clients/http.ts');
    expect(userMsg?.content).toContain('[test] (.github/workflows/ci.yml): npm test');
  });

  it('appends invalid output and validation errors without mutating original messages', () => {
    const original = buildThinkMessages(SAMPLE_INPUT);
    const snapshot = original.map((m) => ({ ...m }));

    const retried = buildRetryMessages(original, '{bad json', [
      'invalid JSON: Expected property name',
    ]);

    expect(original).toEqual(snapshot);
    expect(retried).toHaveLength(4);
    expect(retried[2]).toEqual({ role: 'assistant', content: '{bad json' });
    expect(retried[3]?.role).toBe('user');
    expect(retried[3]?.content).toContain('invalid JSON: Expected property name');
  });
});

describe('runThink', () => {
  it('succeeds on attempt 1 with valid plain-text JSON and default request options', async () => {
    const rawJson = JSON.stringify(VALID_THINK_OUTPUT);
    const timeInfo: ProviderTimeInfo = {
      queue_time: 0.002,
      prompt_time: 0.02,
      completion_time: 0.06,
      total_time: 0.082,
    };
    const mock = createMockClient([
      {
        content: rawJson,
        usage: { prompt_tokens: 512, completion_tokens: 128, total_tokens: 640 },
        timeInfo,
        wallTimeMs: 95,
      },
    ]);

    const result = await runThink(SAMPLE_INPUT, mock.client);

    expect(mock.calls).toHaveLength(1);
    const firstCall = mock.calls[0];
    expect(firstCall?.max_completion_tokens).toBe(DEFAULT_MAX_COMPLETION_TOKENS);
    expect(firstCall?.max_completion_tokens).toBe(1500);
    expect('reasoning_effort' in (firstCall ?? {})).toBe(false);
    expect('reasoning_format' in (firstCall ?? {})).toBe(false);

    expect(result).toEqual({
      output: VALID_THINK_OUTPUT,
      attempts: 1,
      usage: { prompt_tokens: 512, completion_tokens: 128, total_tokens: 640 },
      timeInfo,
      wallTimeMs: 95,
      rawContent: rawJson,
    });
  });

  it('succeeds on attempt 1 when JSON is wrapped in markdown ```json fences', async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(VALID_THINK_OUTPUT, null, 2)}\n\`\`\``;
    const mock = createMockClient([{ content: fenced, wallTimeMs: 80 }]);

    const result = await runThink(SAMPLE_INPUT, mock.client);

    expect(mock.calls).toHaveLength(1);
    expect(result.attempts).toBe(1);
    expect(result.output).toEqual(VALID_THINK_OUTPUT);
    expect(result.rawContent).toBe(fenced);
  });

  it('retries exactly once on malformed JSON with parse error feedback and succeeds on attempt 2', async () => {
    const badJson = '{"likely_failures": [], "commands": [';
    const goodJson = JSON.stringify(VALID_THINK_OUTPUT);
    const mock = createMockClient([
      {
        content: badJson,
        usage: { prompt_tokens: 400, completion_tokens: 30, total_tokens: 430 },
        timeInfo: { queue_time: 0.001, prompt_time: 0.01, completion_time: 0.02, total_time: 0.031 },
        wallTimeMs: 50,
      },
      {
        content: goodJson,
        usage: { prompt_tokens: 480, completion_tokens: 110, total_tokens: 590 },
        timeInfo: { queue_time: 0.002, prompt_time: 0.015, completion_time: 0.04, total_time: 0.057 },
        wallTimeMs: 70,
      },
    ]);

    const result = await runThink(SAMPLE_INPUT, mock.client);

    expect(mock.calls).toHaveLength(2);
    const retryCall = mock.calls[1];
    expect(retryCall?.messages).toHaveLength(4);
    expect(retryCall?.messages[2]).toEqual({ role: 'assistant', content: badJson });
    expect(retryCall?.messages[3]?.role).toBe('user');
    expect(retryCall?.messages[3]?.content).toMatch(/invalid JSON/i);

    expect(result.attempts).toBe(2);
    expect(result.output).toEqual(VALID_THINK_OUTPUT);
    expect(result.wallTimeMs).toBe(120);
    expect(result.usage).toEqual({
      prompt_tokens: 880,
      completion_tokens: 140,
      total_tokens: 1020,
    });
    expect(result.timeInfo?.completion_time).toBeCloseTo(0.06, 6);
    expect(result.timeInfo?.total_time).toBeCloseTo(0.088, 6);
    expect(result.rawContent).toBe(goodJson);
  });

  it('retries once on schema violation with field errors, then throws ThinkValidationError after 2 total calls', async () => {
    const firstBad = JSON.stringify({
      likely_failures: [],
      affected_jobs: ['test'],
      commands: [123],
      notes: 'missing valid command string',
    });
    const secondBad = JSON.stringify({
      likely_failures: [],
      affected_jobs: ['test'],
      notes: 'still missing commands field',
    });
    const mock = createMockClient([
      { content: firstBad },
      { content: secondBad },
      // Extra item ensures we prove chatCompletion is NEVER called a 3rd time.
      { content: JSON.stringify(VALID_THINK_OUTPUT) },
    ]);

    let caught: unknown;
    try {
      await runThink(SAMPLE_INPUT, mock.client);
    } catch (error) {
      caught = error;
    }

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.messages[3]?.content).toContain(
      'commands[0] must be a non-empty string',
    );

    expect(caught).toBeInstanceOf(ThinkValidationError);
    const validationErr = caught as ThinkValidationError;
    expect(validationErr.attempts).toBe(2);
    expect(validationErr.validationErrors).toEqual(['missing required field: commands']);
    expect(validationErr.lastRawContent).toBe(secondBad);
    expect(validationErr.message).toContain('missing required field: commands');
  });

  it('retries once on empty or missing choices[0].message.content and fails clearly when still empty', async () => {
    const mock = createMockClient([
      { omitChoices: true },
      { content: '   ' },
    ]);

    let caught: unknown;
    try {
      await runThink(SAMPLE_INPUT, mock.client);
    } catch (error) {
      caught = error;
    }

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.messages[2]).toEqual({
      role: 'assistant',
      content: '(empty response)',
    });
    expect(mock.calls[1]?.messages[3]?.content).toContain(
      'LLM response missing choices[0].message.content',
    );

    expect(caught).toBeInstanceOf(ThinkValidationError);
    const validationErr = caught as ThinkValidationError;
    expect(validationErr.attempts).toBe(2);
    expect(validationErr.validationErrors).toEqual([
      'empty response: expected a JSON object',
    ]);
    expect(validationErr.lastRawContent).toBe('   ');
  });

  it('recovers on retry when attempt 1 returns null message content and attempt 2 returns valid JSON', async () => {
    const validJson = JSON.stringify(VALID_THINK_OUTPUT);
    const mock = createMockClient([
      { content: null, wallTimeMs: 40 },
      { content: validJson, wallTimeMs: 60 },
    ]);

    const result = await runThink(SAMPLE_INPUT, mock.client);

    expect(mock.calls).toHaveLength(2);
    expect(result.attempts).toBe(2);
    expect(result.output).toEqual(VALID_THINK_OUTPUT);
    expect(result.wallTimeMs).toBe(100);
  });

  it('configures reasoning_effort when think is enabled and gates reasoning_format to groq/cerebras only', async () => {
    const validJson = JSON.stringify(VALID_THINK_OUTPUT);

    const offMock = createMockClient([{ content: validJson }], 'groq');
    await runThink(SAMPLE_INPUT, offMock.client, {
      think: false,
      reasoningEffort: 'high',
      maxCompletionTokens: 1200,
    });
    const offCall = offMock.calls[0];
    expect(offCall?.max_completion_tokens).toBe(1200);
    expect('reasoning_effort' in (offCall ?? {})).toBe(false);
    expect('reasoning_format' in (offCall ?? {})).toBe(false);

    // Ollama, OpenAI, and Gemini receive reasoning_effort but NOT reasoning_format.
    for (const provider of ['ollama', 'openai', 'gemini']) {
      const mock = createMockClient([{ content: validJson }], provider);
      await runThink(SAMPLE_INPUT, mock.client, { think: true });
      const call = mock.calls[0];
      expect(call?.max_completion_tokens).toBe(1500);
      expect(call?.reasoning_effort).toBe('low');
      expect('reasoning_format' in (call ?? {})).toBe(false);
    }

    // Groq and Cerebras receive both reasoning_effort and reasoning_format: 'parsed'.
    const controller = new AbortController();
    for (const provider of ['groq', 'cerebras']) {
      const mock = createMockClient([{ content: validJson }], provider);
      await runThink(SAMPLE_INPUT, mock.client, {
        think: true,
        reasoningEffort: 'medium',
        signal: controller.signal,
      });
      const call = mock.calls[0];
      expect(call?.reasoning_effort).toBe('medium');
      expect(call?.reasoning_format).toBe('parsed');
      expect(call?.signal).toBe(controller.signal);
    }
  });

  it('rejects non-positive maxCompletionTokens without calling the LLM client', async () => {
    const mock = createMockClient([{ content: JSON.stringify(VALID_THINK_OUTPUT) }]);

    await expect(
      runThink(SAMPLE_INPUT, mock.client, { maxCompletionTokens: 0 }),
    ).rejects.toThrow(RangeError);
    expect(mock.calls).toHaveLength(0);
  });

  it('propagates client transport errors directly without masking or retrying', async () => {
    const networkError = new Error('connection refused');
    const mock = createMockClient([networkError]);

    await expect(runThink(SAMPLE_INPUT, mock.client)).rejects.toThrow('connection refused');
    expect(mock.calls).toHaveLength(1);
  });
});
