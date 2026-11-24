import type {
  LikelyFailure,
  ThinkOutput,
  ThinkValidationResult,
} from './types.js';

const MAX_BRACE_CANDIDATES = 100;

interface FencedBlock {
  lang: string;
  body: string;
}

function canParseJson(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function extractFencedBlock(trimmed: string): string | null {
  // Handle a single outer code fence first so embedded triple backticks inside
  // JSON string values are not prematurely split.
  const outerFenceMatch =
    /^```[ \t]*([a-zA-Z0-9_-]*)[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[ \t]*```$/.exec(
      trimmed,
    );
  if (outerFenceMatch !== null) {
    const outerBody = (outerFenceMatch[2] ?? '').trim();
    if (canParseJson(outerBody)) {
      return outerBody;
    }
  }

  const fencePattern = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*(?:\r?\n)?([\s\S]*?)```/g;
  const blocks: FencedBlock[] = [];
  for (const match of trimmed.matchAll(fencePattern)) {
    blocks.push({
      lang: (match[1] ?? '').toLowerCase(),
      body: (match[2] ?? '').trim(),
    });
  }

  if (blocks.length === 0) {
    return null;
  }

  const validJsonTagged = blocks.find(
    (block) => block.lang === 'json' && canParseJson(block.body),
  );
  if (validJsonTagged !== undefined) {
    return validJsonTagged.body;
  }

  const validAnyBlock = blocks.find((block) => canParseJson(block.body));
  if (validAnyBlock !== undefined) {
    return validAnyBlock.body;
  }

  const firstJsonTagged = blocks.find((block) => block.lang === 'json');
  if (firstJsonTagged !== undefined) {
    return firstJsonTagged.body;
  }

  const firstUntagged = blocks.find((block) => block.lang === '');
  if (firstUntagged !== undefined) {
    return firstUntagged.body;
  }

  return null;
}

function extractBalancedJsonObject(text: string): string | null {
  let candidatesChecked = 0;
  let searchFrom = 0;

  while (candidatesChecked < MAX_BRACE_CANDIDATES) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) {
      return null;
    }
    searchFrom = start + 1;
    candidatesChecked += 1;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          if (canParseJson(candidate)) {
            return candidate;
          }
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Extracts raw JSON text from an LLM completion, handling surrounding
 * whitespace, optional markdown code fences, and minor surrounding prose.
 */
export function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const fenced = extractFencedBlock(trimmed);
  if (fenced !== null) {
    return fenced;
  }

  if (canParseJson(trimmed)) {
    return trimmed;
  }

  const balanced = extractBalancedJsonObject(trimmed);
  if (balanced !== null) {
    return balanced;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function validateNonEmptyStringArray(
  record: Record<string, unknown>,
  field: 'affected_jobs' | 'commands',
  errors: string[],
): string[] {
  if (!hasOwn(record, field) || record[field] === undefined) {
    errors.push(`missing required field: ${field}`);
    return [];
  }

  const rawValue = record[field];
  if (!Array.isArray(rawValue)) {
    errors.push(`${field} must be an array`);
    return [];
  }

  const result: string[] = [];
  for (let i = 0; i < rawValue.length; i += 1) {
    const item: unknown = rawValue[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${field}[${i}] must be a non-empty string`);
    } else {
      result.push(item.trim());
    }
  }

  return result;
}

function validateLikelyFailures(
  record: Record<string, unknown>,
  errors: string[],
): LikelyFailure[] {
  if (!hasOwn(record, 'likely_failures') || record.likely_failures === undefined) {
    errors.push('missing required field: likely_failures');
    return [];
  }

  const rawValue = record.likely_failures;
  if (!Array.isArray(rawValue)) {
    errors.push('likely_failures must be an array');
    return [];
  }

  const result: LikelyFailure[] = [];

  for (let i = 0; i < rawValue.length; i += 1) {
    const item: unknown = rawValue[i];
    if (!isPlainObject(item)) {
      errors.push(`likely_failures[${i}] must be an object`);
      continue;
    }

    let itemValid = true;
    let category = '';
    let target = '';
    let reason = '';

    if (!hasOwn(item, 'category') || item.category === undefined) {
      errors.push(`likely_failures[${i}] missing required field: category`);
      itemValid = false;
    } else if (typeof item.category !== 'string' || item.category.trim().length === 0) {
      errors.push(`likely_failures[${i}].category must be a non-empty string`);
      itemValid = false;
    } else {
      category = item.category.trim();
    }

    if (!hasOwn(item, 'target') || item.target === undefined) {
      errors.push(`likely_failures[${i}] missing required field: target`);
      itemValid = false;
    } else if (typeof item.target !== 'string' || item.target.trim().length === 0) {
      errors.push(`likely_failures[${i}].target must be a non-empty string`);
      itemValid = false;
    } else {
      target = item.target.trim();
    }

    if (!hasOwn(item, 'reason') || item.reason === undefined) {
      errors.push(`likely_failures[${i}] missing required field: reason`);
      itemValid = false;
    } else if (typeof item.reason !== 'string' || item.reason.trim().length === 0) {
      errors.push(`likely_failures[${i}].reason must be a non-empty string`);
      itemValid = false;
    } else {
      reason = item.reason.trim();
    }

    let file: string | undefined;
    if (item.file !== undefined) {
      if (typeof item.file !== 'string' || item.file.trim().length === 0) {
        errors.push(`likely_failures[${i}].file must be a non-empty string`);
        itemValid = false;
      } else {
        file = item.file.trim();
      }
    }

    let line: number | undefined;
    if (item.line !== undefined) {
      if (typeof item.line !== 'number' || !Number.isInteger(item.line) || item.line < 1) {
        errors.push(`likely_failures[${i}].line must be a positive integer`);
        itemValid = false;
      } else {
        line = item.line;
      }
    }

    let confidence: number | undefined;
    if (item.confidence !== undefined) {
      if (
        typeof item.confidence !== 'number' ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1
      ) {
        errors.push(`likely_failures[${i}].confidence must be a number in [0, 1]`);
        itemValid = false;
      } else {
        confidence = item.confidence;
      }
    }

    if (itemValid) {
      const normalized: LikelyFailure = { category, target, reason };
      if (file !== undefined) {
        normalized.file = file;
      }
      if (line !== undefined) {
        normalized.line = line;
      }
      if (confidence !== undefined) {
        normalized.confidence = confidence;
      }
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Extracts and validates the plain-text JSON output produced by the Think stage
 * against the Preflight ThinkOutput contract.
 */
export function validateThinkOutput(raw: string): ThinkValidationResult {
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
  } catch (error) {
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

  const likelyFailures = validateLikelyFailures(parsed, errors);
  const affectedJobs = validateNonEmptyStringArray(parsed, 'affected_jobs', errors);
  const commands = validateNonEmptyStringArray(parsed, 'commands', errors);

  let notes = '';
  if (!hasOwn(parsed, 'notes') || parsed.notes === undefined) {
    errors.push('missing required field: notes');
  } else if (typeof parsed.notes !== 'string') {
    errors.push('notes must be a string');
  } else {
    notes = parsed.notes;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: ThinkOutput = {
    likely_failures: likelyFailures,
    affected_jobs: affectedJobs,
    commands,
    notes,
  };

  return { ok: true, value };
}
