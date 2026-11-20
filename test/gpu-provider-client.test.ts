import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MOONSHOT_BASE_URL,
  GpuProviderClient,
  LlmHttpError,
  SingleFlightQueue,
  type FetchLike,
  type SleepFn,
} from '../src/clients/index.js';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

describe('GpuProviderClient (Moonshot Kimi API)', () => {
  it('defaults to Moonshot base URL, returns time_info as null when absent, and extracts usage and wallTimeMs', async () => {
    const responsePayload = {
      id: 'cmpl-moonshot-1',
      object: 'chat.completion',
      model: 'kimi-k2-0905-preview',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 90,
        completion_tokens: 30,
        total_tokens: 120,
      },
    };

    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(responsePayload));
    const client = new GpuProviderClient({
      env: {
        MOONSHOT_API_KEY: 'sk-moonshot-test-12345678',
        MOONSHOT_MODEL: 'kimi-k2-0905-preview',
      },
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${DEFAULT_MOONSHOT_BASE_URL}/chat/completions`);
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-moonshot-test-12345678',
    });

    expect(result.status).toBe(200);
    expect(result.raw).toEqual(responsePayload);
    expect(result.time_info).toBeNull();
    expect(result.usage).toEqual(responsePayload.usage);
    expect(result.wallTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('supports configurable MOONSHOT_BASE_URL and preserves time_info when present', async () => {
    const timeInfo = {
      queue_time: 0.01,
      prompt_time: 0.05,
      completion_time: 0.4,
      total_time: 0.46,
    };
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({
        id: 'cmpl-custom-url',
        time_info: timeInfo,
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );

    const client = new GpuProviderClient({
      env: {
        MOONSHOT_API_KEY: 'sk-moonshot-custom-12345678',
        MOONSHOT_BASE_URL: 'https://api.moonshot.cn/v1/',
        MOONSHOT_MODEL: 'kimi-k2-turbo-preview',
      },
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
    });

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.moonshot.cn/v1/chat/completions');
    expect(result.time_info).toEqual(timeInfo);
  });

  it('retries on HTTP 429 and respects Retry-After', async () => {
    const sleepMock = vi.fn<SleepFn>(async () => undefined);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({ error: 'rate limit' }, 429, { 'Retry-After': '1.5' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'cmpl-moonshot-retried',
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
      );

    const client = new GpuProviderClient({
      apiKey: 'sk-moonshot-retry-12345678',
      model: 'kimi-k2-0905-preview',
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
      retry: {
        maxRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        sleep: sleepMock,
      },
    });

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'retry' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(1500, undefined);
    expect(result.raw.id).toBe('cmpl-moonshot-retried');
    expect(result.time_info).toBeNull();
  });

  it('never leaks MOONSHOT_API_KEY or Authorization header in errors', async () => {
    const secretKey = 'sk-moonshot-super-secret-987654321';
    const client = new GpuProviderClient({
      env: {
        MOONSHOT_API_KEY: secretKey,
        MOONSHOT_MODEL: 'kimi-k2-0905-preview',
      },
      queue: new SingleFlightQueue(),
      fetch: vi.fn<FetchLike>(
        async () =>
          new Response(
            `Forbidden: invalid Authorization: Bearer ${secretKey} (${secretKey})`,
            { status: 403 },
          ),
      ),
    });

    let caught: unknown;
    try {
      await client.chatCompletion({
        messages: [{ role: 'user', content: 'secret test' }],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmHttpError);
    const message = (caught as Error).message;
    expect(message).not.toContain(secretKey);
    expect(message).not.toContain(`Bearer ${secretKey}`);
    expect(message).toContain('[REDACTED]');
  });

  it('fails cleanly when MOONSHOT_API_KEY or MOONSHOT_MODEL is missing', async () => {
    const fetchMock = vi.fn<FetchLike>();

    const noKeyClient = new GpuProviderClient({
      env: { MOONSHOT_MODEL: 'kimi-k2-0905-preview' },
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });
    await expect(
      noKeyClient.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/MOONSHOT_API_KEY/);

    const noModelClient = new GpuProviderClient({
      env: { MOONSHOT_API_KEY: 'sk-moonshot-valid-12345678' },
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });
    await expect(
      noModelClient.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/MOONSHOT_MODEL/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
