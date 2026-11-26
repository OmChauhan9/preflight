import { describe, expect, it } from 'vitest';
import {
  computeTelemetry,
  formatSpeedPanel,
  type TelemetryReport,
} from '../src/telemetry/index.js';

describe('telemetry computeTelemetry', () => {
  it('computes tok_per_s from provider time_info (Cerebras-like) and preserves all 4 time_info fields', () => {
    const report = computeTelemetry({
      provider: 'cerebras',
      model: 'llama-3.3-70b',
      base_url: 'https://api.cerebras.ai/v1',
      usage: {
        prompt_tokens: 1842,
        completion_tokens: 312,
        total_tokens: 2154,
      },
      time_info: {
        queue_time: 0.002,
        prompt_time: 0.041,
        completion_time: 0.15,
        total_time: 0.193,
      },
      timing_ms: {
        gather_ms: 42.36,
        think_ms: 268.44,
        verify_ms: 840.12,
        total_wall_ms: 1150.92,
      },
    });

    expect(report).toEqual({
      provider: 'cerebras',
      model: 'llama-3.3-70b',
      base_url: 'https://api.cerebras.ai/v1',
      usage: {
        prompt_tokens: 1842,
        completion_tokens: 312,
        total_tokens: 2154,
      },
      tok_per_s: 2080,
      tok_per_s_source: 'time_info',
      time_info: {
        queue_time: 0.002,
        prompt_time: 0.041,
        completion_time: 0.15,
        total_time: 0.193,
      },
      timing_ms: {
        gather_ms: 42.4,
        think_ms: 268.4,
        verify_ms: 840.1,
        total_wall_ms: 1150.9,
      },
    });
  });

  it('rounds tok_per_s to 1 decimal place when using time_info', () => {
    const report = computeTelemetry({
      provider: 'cerebras',
      model: 'llama-3.3-70b',
      base_url: 'https://api.cerebras.ai/v1',
      usage: {
        prompt_tokens: 500,
        completion_tokens: 250,
        total_tokens: 750,
      },
      time_info: {
        queue_time: 0.001,
        prompt_time: 0.02,
        completion_time: 0.13,
        total_time: 0.151,
      },
      timing_ms: {
        gather_ms: 10,
        think_ms: 200,
        verify_ms: 300,
        total_wall_ms: 510,
      },
    });

    expect(report.tok_per_s).toBe(1923.1);
    expect(report.tok_per_s_source).toBe('time_info');
  });

  it('falls back to wall-time think_ms when time_info is null (Ollama/OpenAI/Gemini)', () => {
    const report = computeTelemetry({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      base_url: 'http://localhost:11434/v1',
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 180,
        total_tokens: 1380,
      },
      time_info: null,
      timing_ms: {
        gather_ms: 35,
        think_ms: 2400,
        verify_ms: 820,
        total_wall_ms: 3255,
      },
    });

    expect(report.time_info).toBeNull();
    expect(report.tok_per_s).toBe(75);
    expect(report.tok_per_s_source).toBe('wall_time');
    expect(report.timing_ms).toEqual({
      gather_ms: 35,
      think_ms: 2400,
      verify_ms: 820,
      total_wall_ms: 3255,
    });
  });

  it('falls back to think_ms when time_info.completion_time is 0 or missing', () => {
    const report = computeTelemetry({
      provider: 'openai',
      model: 'gpt-4o-mini',
      base_url: 'https://api.openai.com/v1',
      usage: {
        prompt_tokens: 400,
        completion_tokens: 100,
      },
      time_info: {
        queue_time: 0.01,
        completion_time: 0,
      },
      timing_ms: {
        gather_ms: 15,
        think_ms: 500,
        verify_ms: 120,
      },
    });

    expect(report.usage.total_tokens).toBe(500);
    expect(report.tok_per_s).toBe(200);
    expect(report.tok_per_s_source).toBe('wall_time');
    expect(report.time_info).toEqual({
      queue_time: 0.01,
      prompt_time: null,
      completion_time: 0,
      total_time: null,
    });
    expect(report.timing_ms.total_wall_ms).toBe(635);
  });

  it('returns null tok_per_s when completion_tokens is zero or usage is missing', () => {
    const zeroTokens = computeTelemetry({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      base_url: 'http://localhost:11434/v1',
      usage: {
        prompt_tokens: 200,
        completion_tokens: 0,
        total_tokens: 200,
      },
      time_info: {
        queue_time: 0.001,
        prompt_time: 0.05,
        completion_time: 0.1,
        total_time: 0.151,
      },
      timing_ms: {
        gather_ms: 10,
        think_ms: 150,
        verify_ms: 20,
        total_wall_ms: 180,
      },
    });

    expect(zeroTokens.tok_per_s).toBeNull();
    expect(zeroTokens.tok_per_s_source).toBeNull();

    const missingUsage = computeTelemetry({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      usage: null,
      time_info: {},
      timing_ms: {
        gather_ms: 12,
        think_ms: 400,
        verify_ms: 50,
        total_wall_ms: 462,
      },
    });

    expect(missingUsage.usage).toEqual({
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
    });
    expect(missingUsage.time_info).toBeNull();
    expect(missingUsage.tok_per_s).toBeNull();
    expect(missingUsage.tok_per_s_source).toBeNull();
  });

  it('returns null tok_per_s when both completion_time and think_ms are zero', () => {
    const report = computeTelemetry({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      base_url: 'http://localhost:11434/v1',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
      time_info: null,
      timing_ms: {
        gather_ms: -5,
        think_ms: 0,
        verify_ms: Number.NaN,
        total_wall_ms: 0,
      },
    });

    expect(report.tok_per_s).toBeNull();
    expect(report.tok_per_s_source).toBeNull();
    expect(report.timing_ms).toEqual({
      gather_ms: 0,
      think_ms: 0,
      verify_ms: 0,
      total_wall_ms: 0,
    });
  });

  it('redacts embedded credentials and API keys from base_url and metadata', () => {
    const report = computeTelemetry({
      provider: 'custom',
      model: 'my-model',
      base_url:
        'https://alice:top-secret-pass@proxy.example.com/v1?api_key=sk-supersecret1234567890&v=1',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
      time_info: null,
      timing_ms: {
        gather_ms: 5,
        think_ms: 100,
        verify_ms: 10,
        total_wall_ms: 115,
      },
      secrets: ['top-secret-pass', 'sk-supersecret1234567890'],
    });

    expect(report.base_url).not.toContain('alice');
    expect(report.base_url).not.toContain('top-secret-pass');
    expect(report.base_url).not.toContain('sk-supersecret1234567890');
    expect(report.base_url).toContain('https://proxy.example.com/v1');
    expect(report.base_url).toContain('api_key=[REDACTED]');
    expect(report.base_url).toContain('v=1');
  });
});

describe('telemetry formatSpeedPanel & JSON serialization', () => {
  it('formats all fields cleanly when provider time_info is present', () => {
    const report = computeTelemetry({
      provider: 'cerebras',
      model: 'llama-3.3-70b',
      base_url: 'https://api.cerebras.ai/v1',
      usage: {
        prompt_tokens: 1842,
        completion_tokens: 312,
        total_tokens: 2154,
      },
      time_info: {
        queue_time: 0.002,
        prompt_time: 0.041,
        completion_time: 0.15,
        total_time: 0.193,
      },
      timing_ms: {
        gather_ms: 42,
        think_ms: 268,
        verify_ms: 840,
        total_wall_ms: 1150,
      },
    });

    const panel = formatSpeedPanel(report);

    expect(panel).toContain('Speed & Telemetry');
    expect(panel).toContain('cerebras / llama-3.3-70b');
    expect(panel).toContain('https://api.cerebras.ai/v1');
    expect(panel).toContain('in 1842 | out 312 | total 2154');
    expect(panel).toContain('2080.0 tok/s (time_info)');
    expect(panel).toContain(
      'queue 0.002s | prompt 0.041s | completion 0.150s | total 0.193s',
    );
    expect(panel).toContain(
      'gather 42ms | think 268ms | verify 840ms | total 1.15s (1150ms)',
    );
  });

  it('formats client-measured fallback cleanly when time_info is null', () => {
    const report = computeTelemetry({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      base_url: 'http://localhost:11434/v1',
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 240,
        total_tokens: 1440,
      },
      time_info: null,
      timing_ms: {
        gather_ms: 35,
        think_ms: 4000,
        verify_ms: 825,
        total_wall_ms: 4860,
      },
    });

    const panel = formatSpeedPanel(report);

    expect(panel).toContain('ollama / qwen2.5-coder:7b');
    expect(panel).toContain('http://localhost:11434/v1');
    expect(panel).toContain('in 1200 | out 240 | total 1440');
    expect(panel).toContain('60.0 tok/s (wall_time)');
    expect(panel).toContain('n/a (client-measured)');
    expect(panel).toContain(
      'gather 35ms | think 4.00s | verify 825ms | total 4.86s (4860ms)',
    );
  });

  it('formats null throughput and null usage without NaN or leaked secrets', () => {
    const manualReport: TelemetryReport = {
      provider: 'custom',
      model: 'local-model',
      base_url: 'https://user:pw@host.local/v1?token=csk-abcdef1234567890',
      usage: {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
      },
      tok_per_s: null,
      tok_per_s_source: null,
      time_info: null,
      timing_ms: {
        gather_ms: 10,
        think_ms: 0,
        verify_ms: 0,
        total_wall_ms: 10,
      },
    };

    const panel = formatSpeedPanel(manualReport);

    expect(panel).toContain('in n/a | out n/a | total n/a');
    expect(panel).toContain('Throughput : n/a');
    expect(panel).toContain('n/a (client-measured)');
    expect(panel).not.toContain('NaN');
    expect(panel).not.toContain('pw@');
    expect(panel).not.toContain('csk-abcdef1234567890');
  });

  it('round-trips TelemetryReport cleanly through JSON.stringify and JSON.parse', () => {
    const withTimeInfo = computeTelemetry({
      provider: 'cerebras',
      model: 'llama-3.3-70b',
      base_url: 'https://api.cerebras.ai/v1',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
      },
      time_info: {
        queue_time: 0.001,
        prompt_time: 0.03,
        completion_time: 0.1,
        total_time: 0.131,
      },
      timing_ms: {
        gather_ms: 25,
        think_ms: 180,
        verify_ms: 400,
        total_wall_ms: 605,
      },
    });

    const withoutTimeInfo = computeTelemetry({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      base_url: 'http://localhost:11434/v1',
      usage: {
        prompt_tokens: 500,
        completion_tokens: 100,
        total_tokens: 600,
      },
      time_info: null,
      timing_ms: {
        gather_ms: 15,
        think_ms: 1250,
        verify_ms: 300,
        total_wall_ms: 1565,
      },
    });

    expect(JSON.parse(JSON.stringify(withTimeInfo))).toEqual(withTimeInfo);
    expect(JSON.parse(JSON.stringify(withoutTimeInfo))).toEqual(
      withoutTimeInfo,
    );
  });
});
