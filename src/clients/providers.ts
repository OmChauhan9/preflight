export type ProviderName =
  | 'ollama'
  | 'groq'
  | 'gemini'
  | 'openrouter'
  | 'openai'
  | 'cerebras'
  | 'custom';

export const DEFAULT_PROVIDER: ProviderName = 'ollama';

export interface ProviderPreset {
  readonly baseUrl: string;
  readonly requiresApiKey: boolean;
  readonly apiKeyEnv: string;
  readonly defaultModel: string;
}

export const PROVIDER_PRESETS: Readonly<Record<ProviderName, ProviderPreset>> = {
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    apiKeyEnv: 'OLLAMA_API_KEY',
    defaultModel: 'qwen2.5-coder:7b',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true,
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.5-flash-lite',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'qwen/qwen-2.5-coder-32b-instruct:free',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
  },
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1',
    requiresApiKey: true,
    apiKeyEnv: 'CEREBRAS_API_KEY',
    defaultModel: 'llama-3.3-70b',
  },
  custom: {
    baseUrl: '',
    requiresApiKey: false,
    apiKeyEnv: 'PREFLIGHT_API_KEY',
    defaultModel: '',
  },
};

export const PROVIDER_NAMES: readonly ProviderName[] = [
  'ollama',
  'groq',
  'gemini',
  'openrouter',
  'openai',
  'cerebras',
  'custom',
];

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface ResolveProviderConfigOptions {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface ResolvedProviderConfig {
  readonly provider: ProviderName;
  readonly preset: ProviderPreset;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string | undefined;
}

export function isProviderName(value: string): value is ProviderName {
  return Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves provider preset, base URL, model, and optional API key from
 * explicit options, environment variables, and built-in provider defaults.
 */
export function resolveProviderConfig(
  options: ResolveProviderConfigOptions = {},
  env: EnvSource = process.env,
): ResolvedProviderConfig {
  const rawProvider =
    nonEmpty(options.provider) ?? nonEmpty(env.PREFLIGHT_PROVIDER) ?? DEFAULT_PROVIDER;
  const normalizedProvider = rawProvider.toLowerCase();

  if (!isProviderName(normalizedProvider)) {
    throw new Error(
      `Unknown provider "${rawProvider}". Supported providers: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }

  const preset = PROVIDER_PRESETS[normalizedProvider];
  const presetBaseUrl = nonEmpty(preset.baseUrl)?.replace(/\/+$/, '');

  const rawBaseUrl =
    nonEmpty(options.baseUrl) ?? nonEmpty(env.PREFLIGHT_BASE_URL) ?? presetBaseUrl;
  const baseUrl = rawBaseUrl ? rawBaseUrl.replace(/\/+$/, '') : undefined;
  if (!baseUrl) {
    throw new Error(
      `Missing base URL for provider "${normalizedProvider}": set PREFLIGHT_BASE_URL or pass baseUrl.`,
    );
  }

  const hasCustomBaseUrl =
    presetBaseUrl !== undefined && baseUrl !== presetBaseUrl;

  const model =
    nonEmpty(options.model) ?? nonEmpty(env.PREFLIGHT_MODEL) ?? nonEmpty(preset.defaultModel);
  if (!model) {
    throw new Error(
      `Missing model for provider "${normalizedProvider}": set PREFLIGHT_MODEL or pass model.`,
    );
  }

  // Never pair a preset's provider-specific env var (e.g. GROQ_API_KEY) with an
  // overridden base URL so keys cannot be exfiltrated to custom/rogue endpoints.
  const apiKey = hasCustomBaseUrl
    ? (nonEmpty(options.apiKey) ?? nonEmpty(env.PREFLIGHT_API_KEY))
    : (nonEmpty(options.apiKey) ??
      nonEmpty(env.PREFLIGHT_API_KEY) ??
      nonEmpty(env[preset.apiKeyEnv]));

  if (preset.requiresApiKey && !apiKey) {
    if (hasCustomBaseUrl) {
      throw new Error(
        `Missing API key for provider "${normalizedProvider}" with custom base URL: ${preset.apiKeyEnv} is not sent to custom endpoints; set PREFLIGHT_API_KEY or pass apiKey explicitly.`,
      );
    }
    const envHint =
      preset.apiKeyEnv !== 'PREFLIGHT_API_KEY'
        ? `PREFLIGHT_API_KEY or ${preset.apiKeyEnv}`
        : 'PREFLIGHT_API_KEY';
    throw new Error(
      `Missing API key for provider "${normalizedProvider}": set ${envHint}, or pass apiKey.`,
    );
  }

  return {
    provider: normalizedProvider,
    preset,
    baseUrl,
    model,
    apiKey,
  };
}
