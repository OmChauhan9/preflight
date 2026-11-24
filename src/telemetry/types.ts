import type { ChatCompletionUsage, ProviderTimeInfo } from '../clients/types.js';

export interface StageTimingMs {
  gather_ms: number;
  think_ms: number;
  verify_ms: number;
  total_wall_ms: number;
}

export interface StageTimingInput {
  gather_ms?: number;
  think_ms?: number;
  verify_ms?: number;
  total_wall_ms?: number;
}

export interface TelemetryUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface TelemetryTimeInfo {
  queue_time: number | null;
  prompt_time: number | null;
  completion_time: number | null;
  total_time: number | null;
}

export type TokPerSecSource = 'time_info' | 'wall_time' | null;

export interface TelemetryReport {
  provider: string;
  model: string;
  base_url: string;
  usage: TelemetryUsage;
  tok_per_s: number | null;
  tok_per_s_source: TokPerSecSource;
  time_info: TelemetryTimeInfo | null;
  timing_ms: StageTimingMs;
}

export interface ComputeTelemetryInput {
  provider: string;
  model: string;
  base_url: string;
  usage?: ChatCompletionUsage | TelemetryUsage | null;
  time_info?: ProviderTimeInfo | TelemetryTimeInfo | null;
  timing_ms: StageTimingInput;
  secrets?: readonly (string | undefined)[];
}
