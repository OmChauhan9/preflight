import { config as loadDotenv } from 'dotenv';

/**
 * Loads environment variables from a local `.env` file if present,
 * without overriding variables already set in `process.env`.
 */
export function loadEnv(path?: string): void {
  loadDotenv(path ? { path } : undefined);
}
