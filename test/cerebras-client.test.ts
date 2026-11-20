import { describe, expect, it, vi } from 'vitest';
import {
  CerebrasClient,
  DEFAULT_CEREBRAS_BASE_URL,
  DEFAULT_CEREBRAS_MODEL,
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

describe('CerebrasClient', () => {
  it('sends correct URL, headers, and default payload while returning time_info, usage, and wallTimeMs', async () => {
    const responsePayload = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      model: DEFAULT_CEREBRAS_MODEL,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        total_tokens: 165,
      },
      time_info: {
        queue_time: 0.002,
        prompt_time: 0.015,
        completion_time: 0.04,
        total_time: 0.057,
      },
    };

    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(responsePayload));
    const client = new CerebrasClient({
      env: { CEREBRAS_API_KEY: 'csk-test-key-1234567890' },
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'ping' }],
      max_completion_tokens: 256,
      temperature: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${DEFAULT_CEREBRAS_BASE_URL}/chat/completions`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer csk-test-key-1234567890',
    });

    const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(parsedBody).toEqual({
      model: DEFAULT_CEREBRAS_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_completion_tokens: 256,
      temperature: 0,
    });
    expect('reasoning_effort' in parsedBody).toBe(false);

    expect(result.status).toBe(200);
    expect(result.raw).toEqual(responsePayload);
    expect(result.time_info).toEqual(responsePayload.time_info);
    expect(result.usage).toEqual(responsePayload.usage);
    expect(result.wallTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('includes reasoning_effort only when explicitly provided', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({
        id: 'chatcmpl-reason',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
      }),
    );

    const client = new CerebrasClient({
      apiKey: 'csk-test-reasoning-key-123456',
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });

    await client.chatCompletion({
      messages: [{ role: 'user', content: 'think' }],
      reasoning_effort: 'low',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(parsedBody.reasoning_effort).toBe('low');
  });

  it('retries on HTTP 429 using Retry-After header and then succeeds', async () => {
    const sleepMock = vi.fn<SleepFn>(async () => undefined);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({ error: 'rate limited' }, 429, { 'Retry-After': '2' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'chatcmpl-after-429',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          time_info: { queue_time: 0.001, prompt_time: 0.01, completion_time: 0.01, total_time: 0.021 },
        }),
      );

    const client = new CerebrasClient({
      apiKey: 'csk-test-retry-key-123456',
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
      retry: {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        sleep: sleepMock,
      },
    });

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'retry me' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(2000, undefined);
    expect(result.status).toBe(200);
    expect(result.raw.id).toBe('chatcmpl-after-429');
  });

  it('retries on HTTP 429 with bounded exponential backoff and jitter when Retry-After is absent', async () => {
    const sleepMock = vi.fn<SleepFn>(async () => undefined);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: 'still busy' }, 429))
      .mockResolvedValueOnce(jsonResponse({ id: 'chatcmpl-ok' }));

    const client = new CerebrasClient({
      apiKey: 'csk-test-backoff-key-123456',
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
      retry: {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep: sleepMock,
        random: () => 0.5,
      },
    });

    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'backoff' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock.mock.calls).toEqual([
      [75, undefined],
      [150, undefined],
    ]);
    expect(result.raw.id).toBe('chatcmpl-ok');
  });

  it('throws LlmHttpError after exhausting retries on persistent HTTP 429', async () => {
    const sleepMock = vi.fn<SleepFn>(async () => undefined);
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: 'too many requests' }, 429),
    );

    const client = new CerebrasClient({
      apiKey: 'csk-test-exhaust-key-123456',
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
      retry: {
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
        sleep: sleepMock,
        random: () => 0,
      },
    });

    await expect(
      client.chatCompletion({ messages: [{ role: 'user', content: 'fail' }] }),
    ).rejects.toMatchObject({
      name: 'LlmHttpError',
      provider: 'cerebras',
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
  });

  it('enforces single-flight concurrency so concurrent calls never overlap', async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let releaseFirst: (() => void) | undefined;

    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const label = body.messages[0]?.content ?? 'unknown';

      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      events.push(`start:${label}`);

      if (label === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }

      events.push(`end:${label}`);
      inFlight -= 1;
      return jsonResponse({ id: `resp-${label}` });
    });

    const client = new CerebrasClient({
      apiKey: 'csk-test-queue-key-123456',
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });

    const firstPromise = client.chatCompletion({
      messages: [{ role: 'user', content: 'first' }],
    });
    const secondPromise = client.chatCompletion({
      messages: [{ role: 'user', content: 'second' }],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inFlight).toBe(1);

    releaseFirst?.();

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(maxConcurrent).toBe(1);
    expect(events).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ]);
    expect(firstResult.raw.id).toBe('resp-first');
    expect(secondResult.raw.id).toBe('resp-second');
  });

  it('continues running queued requests even if an earlier request fails', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ id: 'resp-second' }, 200));

    const client = new CerebrasClient({
      apiKey: 'csk-test-recover-key-123456',
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });

    const p1 = client.chatCompletion({
      messages: [{ role: 'user', content: 'fail' }],
    });
    const p2 = client.chatCompletion({
      messages: [{ role: 'user', content: 'succeed' }],
    });

    await expect(p1).rejects.toBeInstanceOf(LlmHttpError);
    await expect(p2).resolves.toMatchObject({ raw: { id: 'resp-second' } });
  });

  it('never leaks CEREBRAS_API_KEY or Authorization header in HTTP or network errors', async () => {
    const secretKey = 'csk-super-secret-cerebras-token-999999';

    const httpErrorClient = new CerebrasClient({
      env: { CEREBRAS_API_KEY: secretKey },
      queue: new SingleFlightQueue(),
      fetch: vi.fn<FetchLike>(
        async () =>
          new Response(
            `Unauthorized for Authorization: Bearer ${secretKey} (key=${secretKey})`,
            { status: 401 },
          ),
      ),
    });

    let caughtHttpError: unknown;
    try {
      await httpErrorClient.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      });
    } catch (error) {
      caughtHttpError = error;
    }

    expect(caughtHttpError).toBeInstanceOf(LlmHttpError);
    const httpMessage = (caughtHttpError as Error).message;
    expect(httpMessage).not.toContain(secretKey);
    expect(httpMessage).not.toContain(`Bearer ${secretKey}`);
    expect(httpMessage).toContain('[REDACTED]');

    const networkErrorClient = new CerebrasClient({
      apiKey: secretKey,
      queue: new SingleFlightQueue(),
      fetch: vi.fn<FetchLike>(async () => {
        throw new Error(`socket hang up with header Authorization: Bearer ${secretKey}`);
      }),
    });

    let caughtNetworkError: unknown;
    try {
      await networkErrorClient.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      });
    } catch (error) {
      caughtNetworkError = error;
    }

    expect(caughtNetworkError).toBeInstanceOf(LlmHttpError);
    const networkMessage = (caughtNetworkError as Error).message;
    expect(networkMessage).not.toContain(secretKey);
    expect(networkMessage).toContain('[REDACTED]');
  });

  it('throws a clear error without calling fetch when CEREBRAS_API_KEY is missing', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const client = new CerebrasClient({
      env: {},
      fetch: fetchMock,
      queue: new SingleFlightQueue(),
    });

    await expect(
      client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/CEREBRAS_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
