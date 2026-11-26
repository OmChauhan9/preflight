import { describe, expect, it } from 'vitest';
import {
  createClientFromEnv,
  DEFAULT_PROVIDER,
  LlmHttpError,
  OpenAICompatibleClient,
  PROVIDER_PRESETS,
  redactSecrets,
  resolveProviderConfig,
  SingleFlightQueue,
  type FetchLike,
  type ProviderName,
  type SleepFn,
} from '../src/clients/index.js';

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

function createJsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

function createMockFetch(
  handler: (url: string, init: RequestInit | undefined, callIndex: number) => Promise<Response> | Response,
): { fetch: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const callIndex = calls.length;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init, callIndex));
  };
  return { fetch, calls };
}

function createMockSleep(): { sleep: SleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: SleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

const CLOUD_PRESETS: readonly Exclude<ProviderName, 'ollama' | 'custom'>[] = [
  'groq',
  'gemini',
  'openrouter',
  'openai',
  'cerebras',
];

describe('provider presets & resolveProviderConfig', () => {
  it('defaults to local ollama with no API key required', () => {
    const resolved = resolveProviderConfig({}, {});

    expect(DEFAULT_PROVIDER).toBe('ollama');
    expect(resolved.provider).toBe('ollama');
    expect(resolved.baseUrl).toBe('http://localhost:11434/v1');
    expect(resolved.model).toBe('qwen2.5-coder:7b');
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.preset.requiresApiKey).toBe(false);
  });

  it('ignores empty-string .env placeholders and falls back to preset defaults', () => {
    const resolved = resolveProviderConfig(
      {},
      {
        PREFLIGHT_PROVIDER: '',
        PREFLIGHT_BASE_URL: '   ',
        PREFLIGHT_MODEL: '',
        PREFLIGHT_API_KEY: '',
      },
    );

    expect(resolved.provider).toBe('ollama');
    expect(resolved.baseUrl).toBe('http://localhost:11434/v1');
    expect(resolved.model).toBe('qwen2.5-coder:7b');
    expect(resolved.apiKey).toBeUndefined();
  });

  it.each(CLOUD_PRESETS)(
    'requires an API key for cloud preset %s and accepts PREFLIGHT_API_KEY or provider-specific env var',
    (provider) => {
      const preset = PROVIDER_PRESETS[provider];

      expect(() => resolveProviderConfig({ provider }, {})).toThrow(
        new RegExp(`Missing API key for provider "${provider}".*${preset.apiKeyEnv}`),
      );

      const fromProviderEnv = resolveProviderConfig(
        {},
        {
          PREFLIGHT_PROVIDER: provider,
          [preset.apiKeyEnv]: `provider-secret-${provider}`,
        },
      );
      expect(fromProviderEnv.provider).toBe(provider);
      expect(fromProviderEnv.baseUrl).toBe(preset.baseUrl);
      expect(fromProviderEnv.model).toBe(preset.defaultModel);
      expect(fromProviderEnv.apiKey).toBe(`provider-secret-${provider}`);

      const fromGenericEnv = resolveProviderConfig(
        { provider },
        {
          PREFLIGHT_API_KEY: `generic-secret-${provider}`,
          [preset.apiKeyEnv]: `provider-secret-${provider}`,
        },
      );
      expect(fromGenericEnv.apiKey).toBe(`generic-secret-${provider}`);
    },
  );

  it('uses gemini-3.5-flash-lite as the default model for the gemini preset', () => {
    const resolved = resolveProviderConfig(
      { provider: 'gemini' },
      { GEMINI_API_KEY: 'AIzaSyTest1234567890' },
    );

    expect(PROVIDER_PRESETS.gemini.defaultModel).toBe('gemini-3.5-flash-lite');
    expect(resolved.model).toBe('gemini-3.5-flash-lite');
  });

  it('requires PREFLIGHT_BASE_URL and PREFLIGHT_MODEL for custom provider while keeping apiKey optional', () => {
    expect(() => resolveProviderConfig({ provider: 'custom' }, {})).toThrow(
      /Missing base URL for provider "custom"/,
    );

    expect(() =>
      resolveProviderConfig(
        { provider: 'custom' },
        { PREFLIGHT_BASE_URL: 'http://localhost:8080/v1/' },
      ),
    ).toThrow(/Missing model for provider "custom"/);

    const resolved = resolveProviderConfig(
      {},
      {
        PREFLIGHT_PROVIDER: 'custom',
        PREFLIGHT_BASE_URL: 'http://localhost:8080/v1/',
        PREFLIGHT_MODEL: 'local-coder',
      },
    );
    expect(resolved.provider).toBe('custom');
    expect(resolved.baseUrl).toBe('http://localhost:8080/v1');
    expect(resolved.model).toBe('local-coder');
    expect(resolved.apiKey).toBeUndefined();
  });

  it('throws a clear error for an unknown provider name', () => {
    expect(() => resolveProviderConfig({ provider: 'mystery-llm' }, {})).toThrow(
      /Unknown provider "mystery-llm"/,
    );
  });

  it('never pairs provider-specific env keys with custom baseUrl overrides and requires explicit PREFLIGHT_API_KEY', () => {
    for (const provider of CLOUD_PRESETS) {
      const preset = PROVIDER_PRESETS[provider];

      // Env override pointing to a rogue endpoint must NOT silently use preset.apiKeyEnv.
      expect(() =>
        resolveProviderConfig(
          { provider },
          {
            PREFLIGHT_BASE_URL: 'https://rogue.example/v1',
            [preset.apiKeyEnv]: `secret-for-${provider}`,
          },
        ),
      ).toThrow(/custom base URL.*PREFLIGHT_API_KEY/i);

      // Options baseUrl override must also refuse provider-specific env var.
      expect(() =>
        resolveProviderConfig(
          { provider, baseUrl: 'https://proxy.example/v1' },
          {
            [preset.apiKeyEnv]: `secret-for-${provider}`,
          },
        ),
      ).toThrow(/custom base URL.*PREFLIGHT_API_KEY/i);

      // Explicit PREFLIGHT_API_KEY or options.apiKey IS accepted with custom baseUrl.
      const withExplicitEnvKey = resolveProviderConfig(
        { provider },
        {
          PREFLIGHT_BASE_URL: 'https://proxy.example/v1/',
          PREFLIGHT_API_KEY: 'explicit-proxy-key',
          [preset.apiKeyEnv]: `secret-for-${provider}`,
        },
      );
      expect(withExplicitEnvKey.baseUrl).toBe('https://proxy.example/v1');
      expect(withExplicitEnvKey.apiKey).toBe('explicit-proxy-key');

      const withExplicitOptKey = resolveProviderConfig(
        { provider, baseUrl: 'https://proxy.example/v1', apiKey: 'opt-proxy-key' },
        { [preset.apiKeyEnv]: `secret-for-${provider}` },
      );
      expect(withExplicitOptKey.apiKey).toBe('opt-proxy-key');

      // Matching preset baseUrl (modulo trailing slashes) still accepts provider-specific env var.
      const matchingPresetWithSlash = resolveProviderConfig(
        { provider, baseUrl: `${preset.baseUrl}///` },
        { [preset.apiKeyEnv]: `secret-for-${provider}` },
      );
      expect(matchingPresetWithSlash.baseUrl).toBe(preset.baseUrl);
      expect(matchingPresetWithSlash.apiKey).toBe(`secret-for-${provider}`);
    }

    // Ollama with custom baseUrl must also never send OLLAMA_API_KEY automatically.
    const ollamaCustom = resolveProviderConfig(
      { provider: 'ollama' },
      {
        PREFLIGHT_BASE_URL: 'https://rogue.example/v1',
        OLLAMA_API_KEY: 'ollama-only-secret',
      },
    );
    expect(ollamaCustom.baseUrl).toBe('https://rogue.example/v1');
    expect(ollamaCustom.apiKey).toBeUndefined();
  });
});

describe('OpenAICompatibleClient', () => {
  it('defaults to ollama, omits Authorization header, and returns raw, usage, wallTimeMs, and null time_info', async () => {
    const mock = createMockFetch(() =>
      createJsonResponse({
        id: 'chatcmpl-ollama-1',
        object: 'chat.completion',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"commands":["npm test"]}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 },
      }),
    );

    const client = createClientFromEnv({
      env: {},
      fetch: mock.fetch,
      singleFlightQueue: new SingleFlightQueue(),
    });

    expect(client.provider).toBe('ollama');
    expect(client.baseUrl).toBe('http://localhost:11434/v1');
    expect(client.model).toBe('qwen2.5-coder:7b');

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'Which tests should run?' }],
      max_completion_tokens: 512,
      temperature: 0,
    });

    expect(mock.calls).toHaveLength(1);
    const firstCall = mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.url).toBe('http://localhost:11434/v1/chat/completions');

    const headers = new Headers(firstCall?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);

    const body = JSON.parse(String(firstCall?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'Which tests should run?' }],
      max_completion_tokens: 512,
      temperature: 0,
    });
    expect('reasoning_effort' in body).toBe(false);

    expect(result.status).toBe(200);
    expect(result.raw.id).toBe('chatcmpl-ollama-1');
    expect(result.time_info).toBeNull();
    expect(result.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 18,
      total_tokens: 138,
    });
    expect(result.wallTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('sends Authorization Bearer header and captures provider time_info when returned', async () => {
    const timeInfo = {
      queue_time: 0.0012,
      prompt_time: 0.015,
      completion_time: 0.042,
      total_time: 0.0582,
      created: 1732100000,
    };

    const mock = createMockFetch(() =>
      createJsonResponse({
        id: 'chatcmpl-cerebras-1',
        model: 'llama-3.3-70b',
        choices: [{ index: 0, message: { role: 'assistant', content: '{}' } }],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
        time_info: timeInfo,
      }),
    );

    const client = new OpenAICompatibleClient({
      provider: 'cerebras',
      env: { CEREBRAS_API_KEY: 'csk-testkey1234567890' },
      fetch: mock.fetch,
      singleFlightQueue: new SingleFlightQueue(),
    });

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'Check diff' }],
      reasoning_effort: 'low',
    });

    const firstCall = mock.calls[0];
    expect(firstCall?.url).toBe('https://api.cerebras.ai/v1/chat/completions');
    const headers = new Headers(firstCall?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer csk-testkey1234567890');

    const body = JSON.parse(String(firstCall?.init?.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('low');

    expect(result.time_info).toEqual(timeInfo);
    expect(result.usage).toEqual({
      prompt_tokens: 200,
      completion_tokens: 40,
      total_tokens: 240,
    });
    expect(result.wallTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('retries HTTP 429 using Retry-After header and bounded exponential backoff with jitter', async () => {
    const mockSleep = createMockSleep();
    const mock = createMockFetch((_url, _init, callIndex) => {
      if (callIndex === 0) {
        return createJsonResponse(
          { error: 'rate limited' },
          { status: 429, headers: { 'Retry-After': '1.5' } },
        );
      }
      if (callIndex === 1) {
        return createJsonResponse({ error: 'still limited' }, { status: 429 });
      }
      return createJsonResponse({
        id: 'chatcmpl-after-retry',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
      });
    });

    const client = new OpenAICompatibleClient({
      provider: 'groq',
      apiKey: 'gsk_retrytest1234567890',
      fetch: mock.fetch,
      sleep: mockSleep.sleep,
      random: () => 0.5,
      baseDelayMs: 200,
      maxDelayMs: 2000,
      maxRetries: 3,
      singleFlightQueue: new SingleFlightQueue(),
    });

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'retry test' }],
    });

    expect(result.raw.id).toBe('chatcmpl-after-retry');
    expect(mock.calls).toHaveLength(3);
    // Attempt 0: Retry-After: 1.5 -> 1500ms
    // Attempt 1: exponential = 200 * 2^1 = 400, jitter with random=0.5 -> 400 * 0.75 = 300ms
    expect(mockSleep.delays).toEqual([1500, 300]);
  });

  it('throws LlmHttpError after exhausting HTTP 429 retries', async () => {
    const mockSleep = createMockSleep();
    const mock = createMockFetch(() =>
      createJsonResponse(
        { error: 'rate limit for key gsk_exhausted1234567890' },
        { status: 429, headers: { 'Retry-After': '10' } },
      ),
    );

    const client = new OpenAICompatibleClient({
      provider: 'groq',
      apiKey: 'gsk_exhausted1234567890',
      fetch: mock.fetch,
      sleep: mockSleep.sleep,
      maxRetries: 2,
      maxDelayMs: 1000,
      singleFlightQueue: new SingleFlightQueue(),
    });

    let caught: unknown;
    try {
      await client.chatCompletion({
        messages: [{ role: 'user', content: 'exhaust retries' }],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmHttpError);
    const httpErr = caught as LlmHttpError;
    expect(httpErr.status).toBe(429);
    expect(httpErr.provider).toBe('groq');
    expect(httpErr.message).not.toContain('gsk_exhausted1234567890');
    expect(httpErr.message).toContain('[REDACTED]');
    // Retry-After of 10s bounded to maxDelayMs of 1000ms
    expect(mockSleep.delays).toEqual([1000, 1000]);
  });

  it('serializes concurrent requests through the single-flight queue', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const events: string[] = [];

    const mock = createMockFetch(async (_url, init, callIndex) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const parsed = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const label = parsed.messages[0]?.content ?? `req-${callIndex}`;
      events.push(`start:${label}`);

      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      events.push(`end:${label}`);
      inFlight -= 1;
      return createJsonResponse({
        id: `id-${label}`,
        choices: [{ index: 0, message: { role: 'assistant', content: label } }],
      });
    });

    const queue = new SingleFlightQueue();
    const client = new OpenAICompatibleClient({
      provider: 'ollama',
      env: {},
      fetch: mock.fetch,
      singleFlightQueue: queue,
    });

    const [first, second] = await Promise.all([
      client.chatCompletion({ messages: [{ role: 'user', content: 'first' }] }),
      client.chatCompletion({ messages: [{ role: 'user', content: 'second' }] }),
    ]);

    expect(maxInFlight).toBe(1);
    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    expect(first.raw.id).toBe('id-first');
    expect(second.raw.id).toBe('id-second');
  });

  it('redacts sk-, gsk_, csk-, AIza, Bearer, Authorization, and exact API keys', async () => {
    const exactSecret = 'opaque-custom-token-987654321';
    const rawText = [
      'openai=sk-proj-1234567890abcdef',
      'openrouter=sk-or-v1-abcdef1234567890',
      'groq=gsk_1234567890abcdef',
      'cerebras=csk-1234567890abcdef',
      'gemini=AIzaSyD1234567890abcdef12345',
      'header=Authorization: Bearer super-secret-jwt-value',
      `exact=${exactSecret}`,
      'benign=task-1234567890',
    ].join('\n');

    const redacted = redactSecrets(rawText, [exactSecret]);

    expect(redacted).not.toContain('sk-proj-1234567890abcdef');
    expect(redacted).not.toContain('sk-or-v1-abcdef1234567890');
    expect(redacted).not.toContain('gsk_1234567890abcdef');
    expect(redacted).not.toContain('csk-1234567890abcdef');
    expect(redacted).not.toContain('AIzaSyD1234567890abcdef12345');
    expect(redacted).not.toContain('super-secret-jwt-value');
    expect(redacted).not.toContain(exactSecret);
    expect(redacted).toContain('Authorization: [REDACTED]');
    expect(redacted).toContain('benign=task-1234567890');

    const mock = createMockFetch(() =>
      createJsonResponse(
        {
          error:
            'Unauthorized: rejected AIzaSyLeakKey1234567890 and Bearer my-bearer-secret and opaque-custom-token-987654321',
        },
        { status: 401 },
      ),
    );

    const client = new OpenAICompatibleClient({
      provider: 'gemini',
      apiKey: exactSecret,
      fetch: mock.fetch,
      singleFlightQueue: new SingleFlightQueue(),
    });

    let caught: unknown;
    try {
      await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmHttpError);
    const httpErr = caught as LlmHttpError;
    expect(httpErr.status).toBe(401);
    expect(httpErr.message).not.toContain('AIzaSyLeakKey1234567890');
    expect(httpErr.message).not.toContain('my-bearer-secret');
    expect(httpErr.message).not.toContain(exactSecret);
    expect(httpErr.message).toContain('[REDACTED]');
  });

  it('supports custom endpoints with or without an API key', async () => {
    const mock = createMockFetch(() =>
      createJsonResponse({
        id: 'chatcmpl-custom-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
      }),
    );

    const noAuthClient = createClientFromEnv({
      env: {
        PREFLIGHT_PROVIDER: 'custom',
        PREFLIGHT_BASE_URL: 'http://localhost:8080/v1/',
        PREFLIGHT_MODEL: 'local-coder',
      },
      fetch: mock.fetch,
      singleFlightQueue: new SingleFlightQueue(),
    });
    await noAuthClient.chatCompletion({ messages: [{ role: 'user', content: 'ping' }] });

    const withAuthClient = createClientFromEnv({
      env: {
        PREFLIGHT_PROVIDER: 'custom',
        PREFLIGHT_BASE_URL: 'http://localhost:8080/v1',
        PREFLIGHT_MODEL: 'local-coder',
        PREFLIGHT_API_KEY: 'custom-secret-key',
      },
      fetch: mock.fetch,
      singleFlightQueue: new SingleFlightQueue(),
    });
    await withAuthClient.chatCompletion({ messages: [{ role: 'user', content: 'ping' }] });

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.url).toBe('http://localhost:8080/v1/chat/completions');
    expect(new Headers(mock.calls[0]?.init?.headers).has('authorization')).toBe(false);
    expect(new Headers(mock.calls[1]?.init?.headers).get('authorization')).toBe(
      'Bearer custom-secret-key',
    );
  });

  it('aborts with LlmHttpError when timeoutMs is exceeded', async () => {
    const mock = createMockFetch((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(init.signal?.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    });

    const client = new OpenAICompatibleClient({
      provider: 'ollama',
      env: {},
      fetch: mock.fetch,
      timeoutMs: 20,
      singleFlightQueue: new SingleFlightQueue(),
    });

    await expect(
      client.chatCompletion({ messages: [{ role: 'user', content: 'slow request' }] }),
    ).rejects.toThrow(/ollama request timed out after 20ms/);
  });

  it('sends reasoning_format only for groq and cerebras and omits it for openai, gemini, ollama, openrouter, and custom', async () => {
    const mock = createMockFetch(() =>
      createJsonResponse({
        id: 'chatcmpl-reasoning-gate',
        choices: [{ index: 0, message: { role: 'assistant', content: '{}' } }],
      }),
    );

    const omittedProviders: Array<{ provider: ProviderName; env: Record<string, string> }> = [
      { provider: 'openai', env: { OPENAI_API_KEY: 'sk-test1234567890' } },
      { provider: 'gemini', env: { GEMINI_API_KEY: 'AIzaTest1234567890' } },
      { provider: 'ollama', env: {} },
      { provider: 'openrouter', env: { OPENROUTER_API_KEY: 'sk-or-test1234567890' } },
      {
        provider: 'custom',
        env: {
          PREFLIGHT_BASE_URL: 'http://localhost:8080/v1',
          PREFLIGHT_MODEL: 'local-coder',
        },
      },
    ];

    for (const entry of omittedProviders) {
      const client = new OpenAICompatibleClient({
        provider: entry.provider,
        env: entry.env,
        fetch: mock.fetch,
        singleFlightQueue: new SingleFlightQueue(),
      });
      await client.chatCompletion({
        messages: [{ role: 'user', content: 'test' }],
        reasoning_effort: 'low',
        reasoning_format: 'parsed',
      });
      const lastCall = mock.calls[mock.calls.length - 1];
      const body = JSON.parse(String(lastCall?.init?.body)) as Record<string, unknown>;
      expect(body.reasoning_effort).toBe('low');
      expect('reasoning_format' in body).toBe(false);
    }

    const includedProviders: Array<{ provider: ProviderName; env: Record<string, string> }> = [
      { provider: 'groq', env: { GROQ_API_KEY: 'gsk_test1234567890' } },
      { provider: 'cerebras', env: { CEREBRAS_API_KEY: 'csk-test1234567890' } },
    ];

    for (const entry of includedProviders) {
      const client = new OpenAICompatibleClient({
        provider: entry.provider,
        env: entry.env,
        fetch: mock.fetch,
        singleFlightQueue: new SingleFlightQueue(),
      });
      await client.chatCompletion({
        messages: [{ role: 'user', content: 'test' }],
        reasoning_effort: 'low',
        reasoning_format: 'parsed',
      });
      const lastCall = mock.calls[mock.calls.length - 1];
      const body = JSON.parse(String(lastCall?.init?.body)) as Record<string, unknown>;
      expect(body.reasoning_effort).toBe('low');
      expect(body.reasoning_format).toBe('parsed');
    }
  });

  it('includes error.cause details on network failures and appends an actionable Ollama recovery hint', async () => {
    const connRefused = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:11434'),
      { code: 'ECONNREFUSED' },
    );
    const ollamaMock = createMockFetch(() =>
      Promise.reject(new TypeError('fetch failed', { cause: connRefused })),
    );

    const ollamaClient = new OpenAICompatibleClient({
      provider: 'ollama',
      env: {},
      fetch: ollamaMock.fetch,
      singleFlightQueue: new SingleFlightQueue(),
    });

    let ollamaErr: unknown;
    try {
      await ollamaClient.chatCompletion({
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (error) {
      ollamaErr = error;
    }

    expect(ollamaErr).toBeInstanceOf(LlmHttpError);
    const ollamaMsg = (ollamaErr as LlmHttpError).message;
    expect(ollamaMsg).toContain('ECONNREFUSED');
    expect(ollamaMsg).toContain(
      'Ensure Ollama is running at http://localhost:11434/v1 ("ollama serve") or select another preset with --provider.',
    );

    // Also handles Node 22 AggregateError causes (dual-stack localhost refusal).
    const aggregateCause = Object.assign(
      new AggregateError([
        Object.assign(new Error('connect ECONNREFUSED ::1:11434'), {
          code: 'ECONNREFUSED',
        }),
      ]),
      { code: 'ECONNREFUSED' },
    );
    const aggMock = createMockFetch(() =>
      Promise.reject(new TypeError('fetch failed', { cause: aggregateCause })),
    );
    const aggClient = new OpenAICompatibleClient({
      provider: 'ollama',
      env: {},
      fetch: aggMock.fetch,
      singleFlightQueue: new SingleFlightQueue(),
    });
    await expect(
      aggClient.chatCompletion({ messages: [{ role: 'user', content: 'ping' }] }),
    ).rejects.toThrow(/ECONNREFUSED.*ollama serve/i);

    // Non-Ollama providers include redacted cause details without the Ollama hint.
    const openaiSecret = 'opaque-openai-network-secret-777';
    const openaiCause = Object.assign(
      new Error(`getaddrinfo ENOTFOUND api.openai.com using ${openaiSecret}`),
      { code: 'ENOTFOUND' },
    );
    const openaiMock = createMockFetch(() =>
      Promise.reject(new TypeError('fetch failed', { cause: openaiCause })),
    );
    const openaiClient = new OpenAICompatibleClient({
      provider: 'openai',
      apiKey: openaiSecret,
      fetch: openaiMock.fetch,
      singleFlightQueue: new SingleFlightQueue(),
    });

    let openaiErr: unknown;
    try {
      await openaiClient.chatCompletion({
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (error) {
      openaiErr = error;
    }

    expect(openaiErr).toBeInstanceOf(LlmHttpError);
    const openaiMsg = (openaiErr as LlmHttpError).message;
    expect(openaiMsg).toContain('ENOTFOUND');
    expect(openaiMsg).toContain('[REDACTED]');
    expect(openaiMsg).not.toContain(openaiSecret);
    expect(openaiMsg).not.toContain('ollama serve');
  });
});
