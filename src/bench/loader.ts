import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  BenchCase,
  BenchCaseStatus,
  BenchLabelVerified,
  LoadBenchCasesOptions,
} from './types.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
  filePath: string,
): string {
  if (!hasOwn(record, field)) {
    throw new Error(`Invalid benchmark case "${filePath}": missing required field "${field}"`);
  }
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "${field}" must be a non-empty string`,
    );
  }
  return value;
}

function readRequiredPositiveInt(
  record: Record<string, unknown>,
  field: string,
  filePath: string,
): number {
  if (!hasOwn(record, field)) {
    throw new Error(`Invalid benchmark case "${filePath}": missing required field "${field}"`);
  }
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "${field}" must be a positive integer`,
    );
  }
  return value;
}

function readNullableString(
  record: Record<string, unknown>,
  field: string,
  filePath: string,
): string | null {
  if (!hasOwn(record, field)) {
    throw new Error(`Invalid benchmark case "${filePath}": missing required field "${field}"`);
  }
  const value = record[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "${field}" must be a non-empty string or null`,
    );
  }
  return value;
}

function readStatus(record: Record<string, unknown>, filePath: string): BenchCaseStatus {
  if (!hasOwn(record, 'status')) {
    throw new Error(`Invalid benchmark case "${filePath}": missing required field "status"`);
  }
  const value = record.status;
  if (value !== 'fail' && value !== 'pass') {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "status" must be "fail" or "pass"`,
    );
  }
  return value;
}

function readChangedFiles(record: Record<string, unknown>, filePath: string): string[] {
  if (!hasOwn(record, 'changed_files')) {
    throw new Error(
      `Invalid benchmark case "${filePath}": missing required field "changed_files"`,
    );
  }
  const value = record.changed_files;
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "changed_files" must be an array of strings`,
    );
  }
  const files: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry: unknown = value[i];
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(
        `Invalid benchmark case "${filePath}": changed_files[${i}] must be a non-empty string`,
      );
    }
    files.push(entry);
  }
  return files;
}

function readLabelVerified(
  record: Record<string, unknown>,
  filePath: string,
): BenchLabelVerified {
  if (!hasOwn(record, 'label_verified')) {
    throw new Error(
      `Invalid benchmark case "${filePath}": missing required field "label_verified"`,
    );
  }
  const value = record.label_verified;
  if (!isPlainRecord(value)) {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "label_verified" must be an object`,
    );
  }
  if (typeof value.checked_against_log !== 'boolean') {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "label_verified.checked_against_log" must be a boolean`,
    );
  }
  if (typeof value.checked_against_diff !== 'boolean') {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "label_verified.checked_against_diff" must be a boolean`,
    );
  }
  if (typeof value.notes !== 'string') {
    throw new Error(
      `Invalid benchmark case "${filePath}": field "label_verified.notes" must be a string`,
    );
  }
  return {
    checked_against_log: value.checked_against_log,
    checked_against_diff: value.checked_against_diff,
    notes: value.notes,
  };
}

function parseBenchCaseFile(filePath: string): BenchCase {
  let rawText: string;
  try {
    rawText = readFileSync(filePath, 'utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read benchmark case "${filePath}": ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed JSON in benchmark case "${filePath}": ${reason}`);
  }

  if (!isPlainRecord(parsed)) {
    throw new Error(
      `Invalid benchmark case "${filePath}": top-level JSON value must be an object`,
    );
  }

  return {
    id: readRequiredString(parsed, 'id', filePath),
    status: readStatus(parsed, filePath),
    repo: readRequiredString(parsed, 'repo', filePath),
    pr: readRequiredPositiveInt(parsed, 'pr', filePath),
    pr_url: readRequiredString(parsed, 'pr_url', filePath),
    language: readRequiredString(parsed, 'language', filePath),
    base_sha: readRequiredString(parsed, 'base_sha', filePath),
    head_sha: readRequiredString(parsed, 'head_sha', filePath),
    workflow_file: readRequiredString(parsed, 'workflow_file', filePath),
    run_id: readRequiredPositiveInt(parsed, 'run_id', filePath),
    run_url: readRequiredString(parsed, 'run_url', filePath),
    failing_job: readNullableString(parsed, 'failing_job', filePath),
    failing_command: readNullableString(parsed, 'failing_command', filePath),
    log_excerpt: readNullableString(parsed, 'log_excerpt', filePath),
    changed_files: readChangedFiles(parsed, filePath),
    root_cause_label: readRequiredString(parsed, 'root_cause_label', filePath),
    label_verified: readLabelVerified(parsed, filePath),
  };
}

/**
 * Loads, validates, and filters benchmark cases from `bench/cases/*.json` in
 * deterministic sorted filename order.
 */
export function loadBenchCases(options: LoadBenchCasesOptions): BenchCase[] {
  if (
    options.status !== undefined &&
    options.status !== 'fail' &&
    options.status !== 'pass' &&
    options.status !== 'all'
  ) {
    throw new RangeError(
      `Invalid status filter "${String(options.status)}": expected "fail", "pass", or "all"`,
    );
  }

  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit <= 0)
  ) {
    throw new RangeError('limit must be a positive integer');
  }

  const resolvedDir =
    options.casesDir !== undefined && options.casesDir.trim().length > 0
      ? path.resolve(options.cwd, options.casesDir)
      : path.resolve(options.cwd, 'bench/cases');

  if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
    throw new Error(`Benchmark cases directory not found: ${resolvedDir}`);
  }

  const entries = readdirSync(resolvedDir)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const allCases = entries.map((filename) =>
    parseBenchCaseFile(path.join(resolvedDir, filename)),
  );

  let filtered = allCases;

  if (options.caseId !== undefined && options.caseId.trim().length > 0) {
    const targetId = options.caseId.trim();
    const matched = filtered.filter((item) => item.id === targetId);
    if (matched.length === 0) {
      throw new Error(
        `Benchmark case "${targetId}" not found in ${resolvedDir}`,
      );
    }
    filtered = matched;
  }

  if (options.status !== undefined && options.status !== 'all') {
    const targetStatus = options.status;
    filtered = filtered.filter((item) => item.status === targetStatus);
  }

  if (options.language !== undefined && options.language.trim().length > 0) {
    const targetLanguage = options.language.trim().toLowerCase();
    filtered = filtered.filter(
      (item) => item.language.toLowerCase() === targetLanguage,
    );
  }

  if (options.limit !== undefined) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}
