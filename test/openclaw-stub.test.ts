import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills', 'preflight', 'SKILL.md');
const README_PATH = path.join(REPO_ROOT, 'openclaw', 'README.md');
const DIST_CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli.js');

type YamlObject = { [key: string]: YamlValue };
type YamlValue = string | YamlValue[] | YamlObject;

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'Cerebras API key', pattern: /\bcsk-[A-Za-z0-9_-]{8,}\b/ },
  { label: 'OpenAI/Moonshot-style API key', pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/ },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  {
    label: 'hardcoded JSON apiKey',
    pattern: /"apiKey"\s*:\s*"(?!\$\{[A-Z0-9_]+\}")[^"]+"/,
  },
];

function isYamlObject(value: YamlValue | undefined): value is YamlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: YamlValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('Unexpected empty YAML scalar');
  }

  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      throw new Error(`Unterminated double-quoted YAML string: ${trimmed}`);
    }
    const inner = trimmed.slice(1, -1);
    if (inner.replace(/\\"/g, '').includes('"')) {
      throw new Error(`Unescaped double quote in YAML string: ${trimmed}`);
    }
    return inner.replace(/\\"/g, '"');
  }

  if (trimmed.startsWith("'")) {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) {
      throw new Error(`Unterminated single-quoted YAML string: ${trimmed}`);
    }
    const inner = trimmed.slice(1, -1);
    if (inner.replace(/''/g, '').includes("'")) {
      throw new Error(`Unescaped single quote in YAML string: ${trimmed}`);
    }
    return inner.replace(/''/g, "'");
  }

  if (trimmed.includes(': ')) {
    throw new Error(`Unquoted colon-space in YAML scalar: ${trimmed}`);
  }

  if (
    trimmed.includes('[') ||
    trimmed.includes(']') ||
    trimmed.includes('{') ||
    trimmed.includes('}')
  ) {
    throw new Error(`Unexpected bracket/brace in plain YAML scalar: ${trimmed}`);
  }

  return trimmed;
}

function parseYamlInlineValue(raw: string): YamlValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) {
      throw new Error(`Unterminated YAML flow sequence: ${trimmed}`);
    }
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }
    return inner.split(',').map((item) => parseYamlScalar(item));
  }
  return parseYamlScalar(trimmed);
}

function getLineIndent(line: string): number {
  if (/^\t/.test(line)) {
    throw new Error(`Tab indentation is invalid in YAML: ${line}`);
  }
  const match = /^( *)/.exec(line);
  return match?.[1]?.length ?? 0;
}

function findNextContentLine(lines: readonly string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      return lines.length;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      return i;
    }
  }
  return lines.length;
}

function parseYamlBlock(
  lines: readonly string[],
  startIndex: number,
  expectedIndent: number,
): { value: YamlValue; nextIndex: number } {
  const firstIndex = findNextContentLine(lines, startIndex);
  const firstLine = lines[firstIndex];
  if (firstLine === undefined) {
    throw new Error('Unexpected end of YAML frontmatter');
  }

  const blockIndent = getLineIndent(firstLine);
  if (blockIndent !== expectedIndent) {
    throw new Error(`Unexpected YAML indentation at line ${firstIndex + 1}: ${firstLine}`);
  }

  const firstTrimmed = firstLine.trim();
  if (firstTrimmed === '-' || firstTrimmed.startsWith('- ')) {
    const items: YamlValue[] = [];
    let i = firstIndex;

    while (i < lines.length) {
      const nextContent = findNextContentLine(lines, i);
      const line = lines[nextContent];
      if (line === undefined) {
        i = lines.length;
        break;
      }

      const indent = getLineIndent(line);
      if (indent < blockIndent) {
        i = nextContent;
        break;
      }
      if (indent > blockIndent) {
        throw new Error(`Unexpected YAML list indentation at line ${nextContent + 1}: ${line}`);
      }

      const trimmed = line.trim();
      if (trimmed !== '-' && !trimmed.startsWith('- ')) {
        i = nextContent;
        break;
      }

      const rest = trimmed.slice(1).trim();
      if (rest.length === 0) {
        throw new Error(`Empty YAML list item at line ${nextContent + 1}`);
      }
      items.push(parseYamlInlineValue(rest));
      i = nextContent + 1;
    }

    return { value: items, nextIndex: i };
  }

  const record: YamlObject = {};
  let i = firstIndex;

  while (i < lines.length) {
    const nextContent = findNextContentLine(lines, i);
    const line = lines[nextContent];
    if (line === undefined) {
      i = lines.length;
      break;
    }

    const indent = getLineIndent(line);
    if (indent < blockIndent) {
      i = nextContent;
      break;
    }
    if (indent > blockIndent) {
      throw new Error(`Unexpected YAML mapping indentation at line ${nextContent + 1}: ${line}`);
    }

    const trimmed = line.trim();
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(trimmed);
    if (!match || match[1] === undefined) {
      throw new Error(`Invalid YAML mapping entry at line ${nextContent + 1}: ${trimmed}`);
    }

    const key = match[1];
    const inlineValue = match[2]?.trim();

    if (inlineValue !== undefined && inlineValue.length > 0) {
      record[key] = parseYamlInlineValue(inlineValue);
      i = nextContent + 1;
    } else {
      const childIndex = findNextContentLine(lines, nextContent + 1);
      const childLine = lines[childIndex];
      if (childLine === undefined) {
        throw new Error(`Missing nested YAML value for key "${key}"`);
      }
      const childIndent = getLineIndent(childLine);
      if (childIndent <= blockIndent) {
        throw new Error(`Expected indented YAML block under key "${key}"`);
      }
      const parsedChild = parseYamlBlock(lines, childIndex, childIndent);
      record[key] = parsedChild.value;
      i = parsedChild.nextIndex;
    }
  }

  return { value: record, nextIndex: i };
}

function parseFrontmatterDocument(markdown: string): {
  frontmatter: YamlObject;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error('Missing valid YAML frontmatter delimited by --- lines');
  }

  const lines = match[1].split(/\r?\n/);
  const parsed = parseYamlBlock(lines, 0, 0);
  const trailing = findNextContentLine(lines, parsed.nextIndex);
  if (trailing < lines.length) {
    throw new Error(`Unparsed trailing YAML content at line ${trailing + 1}`);
  }
  if (!isYamlObject(parsed.value)) {
    throw new Error('YAML frontmatter root must be a mapping');
  }

  return {
    frontmatter: parsed.value,
    body: match[2],
  };
}

function createCapturedIo(): {
  io: CliIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

describe('Phase 0 OpenClaw skill stub', () => {
  it('validates skills/preflight/SKILL.md frontmatter, instructions, and secret hygiene', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);

    const content = readFileSync(SKILL_PATH, 'utf8');
    const { frontmatter, body } = parseFrontmatterDocument(content);

    expect(frontmatter.name).toBe('preflight');
    const description = frontmatter.description;
    expect(typeof description).toBe('string');
    expect(typeof description === 'string' && description.trim().length > 0).toBe(true);

    const allowedTools = frontmatter['allowed-tools'];
    expect(isStringArray(allowedTools)).toBe(true);
    expect(allowedTools).toContain('exec');

    const metadata = frontmatter.metadata;
    expect(isYamlObject(metadata)).toBe(true);
    const openclaw = isYamlObject(metadata) ? metadata.openclaw : undefined;
    expect(isYamlObject(openclaw)).toBe(true);
    const requires = isYamlObject(openclaw) ? openclaw.requires : undefined;
    expect(isYamlObject(requires)).toBe(true);
    const bins = isYamlObject(requires) ? requires.bins : undefined;
    expect(isStringArray(bins)).toBe(true);
    expect(bins).toContain('preflight');

    const invocation = isYamlObject(openclaw) ? openclaw.invocation : undefined;
    expect(typeof invocation).toBe('string');
    expect(typeof invocation === 'string' && invocation.trim().length > 0).toBe(true);

    expect(body).toMatch(/\bpreflight\s+check\b/);
    expect(body).toContain('node dist/cli.js check');
    expect(body).toContain('npx --no-install preflight check');
    expect(body).toMatch(/\bexec\b/);
    expect(body).toMatch(/verbatim/i);
    expect(body).toContain('preflight check --json');

    for (const { label, pattern } of SECRET_PATTERNS) {
      expect(content, `Unexpected ${label} found in SKILL.md`).not.toMatch(pattern);
    }
  });

  it('validates openclaw/README.md setup guide and secret hygiene', () => {
    expect(existsSync(README_PATH)).toBe(true);

    const readme = readFileSync(README_PATH, 'utf8');
    expect(readme).toContain('skills/preflight/SKILL.md');
    expect(readme).toContain('openclaw config patch --stdin');
    expect(readme).toContain('cerebras/moonshotai-kimi-k3.1-pro-trial');
    expect(readme).toContain('openclaw models auth paste-api-key --provider cerebras');
    expect(readme).toContain('CEREBRAS_API_KEY');
    expect(readme).toContain('openclaw agent --local');

    for (const { label, pattern } of SECRET_PATTERNS) {
      expect(readme, `Unexpected ${label} found in openclaw/README.md`).not.toMatch(pattern);
    }
  });

  it('runs the preflight check command referenced by SKILL.md and outputs "not implemented" with exit code 0', () => {
    const skillContent = readFileSync(SKILL_PATH, 'utf8');
    const commandMatch = /\bpreflight\s+(check)\b/.exec(skillContent);
    expect(commandMatch?.[1]).toBe('check');

    const subcommand = commandMatch?.[1] ?? 'check';
    const captured = createCapturedIo();
    const exitCode = runCli([subcommand], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.stdout).toEqual(['not implemented']);
    expect(captured.stderr).toEqual([]);

    if (existsSync(DIST_CLI_PATH)) {
      const result = spawnSync(process.execPath, [DIST_CLI_PATH, subcommand], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('not implemented');
      expect(result.stderr).toBe('');
    }
  });
});
