import { extractJsonText } from '../think/schema.js';
import type { ExplainOutput, ExplainValidationResult } from './types.js';

export { extractJsonText } from '../think/schema.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validateRequiredNonEmptyString(
  record: Record<string, unknown>,
  field: 'root_cause' | 'suggested_patch' | 'explanation',
  errors: string[],
): string {
  if (!hasOwn(record, field) || record[field] === undefined) {
    errors.push(`missing required field: ${field}`);
    return '';
  }

  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
    return '';
  }

  return value.trim();
}

/**
 * Extracts and validates the plain-text JSON output produced by the Explain stage
 * against the Preflight ExplainOutput contract.
 */
export function validateExplainOutput(raw: string): ExplainValidationResult {
  const jsonText = extractJsonText(raw);
  if (jsonText.length === 0) {
    return {
      ok: false,
      errors: ['empty response: expected a JSON object'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [`invalid JSON: ${detail}`],
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      errors: ['top-level JSON value must be an object'],
    };
  }

  const errors: string[] = [];

  const rootCause = validateRequiredNonEmptyString(parsed, 'root_cause', errors);

  let failingCommand: string | null = null;
  if (!hasOwn(parsed, 'failing_command') || parsed.failing_command === undefined) {
    errors.push('missing required field: failing_command');
  } else if (parsed.failing_command === null) {
    failingCommand = null;
  } else if (
    typeof parsed.failing_command !== 'string' ||
    parsed.failing_command.trim().length === 0
  ) {
    errors.push('failing_command must be a non-empty string or null');
  } else {
    failingCommand = parsed.failing_command.trim();
  }

  const suggestedPatch = validateRequiredNonEmptyString(
    parsed,
    'suggested_patch',
    errors,
  );
  const explanation = validateRequiredNonEmptyString(parsed, 'explanation', errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: ExplainOutput = {
    root_cause: rootCause,
    failing_command: failingCommand,
    suggested_patch: suggestedPatch,
    explanation,
  };

  return { ok: true, value };
}
