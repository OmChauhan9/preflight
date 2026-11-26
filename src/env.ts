import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';

export interface LoadEnvOptions {
  /** Target environment object to populate without overriding existing keys. Defaults to `process.env`. */
  targetEnv?: Record<string, string | undefined>;
  /** Override home directory used when resolving `~/.config/preflight/.env`. */
  homeDir?: string;
}

/**
 * Resolves the user-scoped Preflight `.env` path:
 * `$XDG_CONFIG_HOME/preflight/.env` when `XDG_CONFIG_HOME` is set,
 * otherwise `~/.config/preflight/.env`.
 */
export function resolveDefaultEnvPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = os.homedir(),
): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const configRoot =
    xdgConfigHome && xdgConfigHome.length > 0
      ? xdgConfigHome
      : path.join(homeDir, '.config');
  return path.join(configRoot, 'preflight', '.env');
}

function loadEnvFromFile(
  filePath: string,
  targetEnv: Record<string, string | undefined>,
): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load env file "${filePath}": ${reason}`);
  }

  const parsed = parseDotenv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }
}

/**
 * Loads environment variables from an explicit `envFilePath` or from the user's
 * config directory (`$XDG_CONFIG_HOME/preflight/.env` or `~/.config/preflight/.env`)
 * when present, without overriding variables already set in `targetEnv` (`process.env`).
 *
 * Deliberately never auto-loads `.env` from `process.cwd()` so untrusted target
 * repositories cannot inject `PREFLIGHT_BASE_URL` or override LLM credentials.
 */
export function loadEnv(
  envFilePath?: string,
  options?: LoadEnvOptions,
): void {
  const targetEnv = options?.targetEnv ?? process.env;

  if (envFilePath !== undefined) {
    const trimmed = envFilePath.trim();
    if (trimmed.length === 0) {
      throw new Error('Environment file path must be a non-empty string.');
    }
    loadEnvFromFile(trimmed, targetEnv);
    return;
  }

  const defaultPath = resolveDefaultEnvPath(targetEnv, options?.homeDir);
  if (!existsSync(defaultPath)) {
    return;
  }
  try {
    if (!statSync(defaultPath).isFile()) {
      return;
    }
  } catch {
    return;
  }

  loadEnvFromFile(defaultPath, targetEnv);
}
