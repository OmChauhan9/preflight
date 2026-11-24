import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const SKILL_PATH = path.resolve(REPO_ROOT, 'skills', 'preflight', 'SKILL.md');
const AGENT_SETUP_PATH = path.resolve(REPO_ROOT, 'docs', 'agent-setup.md');
const DIST_CLI_PATH = path.resolve(REPO_ROOT, 'dist', 'cli.js');

interface YamlObject {
  [key: string]: YamlValue;
}

type YamlValue = string | string[] | YamlObject;

interface ParsedSkill {
  frontmatter: YamlObject;
  body: string;
}

const BANNED_STRINGS = [
  'moonshotai-kimi-k3.1-pro-trial',
  'hackathon',
  '#kimioncerebras',
] as const;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgsk_[A-Za-z0-9_-]{16,}\b/,
  /\bcsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /Authorization:\s*Bearer\s+(?!<|your|\$)[A-Za-z0-9._-]{16,}/i,
];

function isYamlObject(value: YamlValue | undefined): value is YamlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }
  return inner.split(',').map((item) => unquoteYamlScalar(item));
}

function getIndent(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === ' ') {
    count += 1;
  }
  return count;
}

function findNextContentLine(lines: readonly string[], fromIndex: number): number {
  for (let i = fromIndex; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      return i;
    }
  }
  return -1;
}

function parseYamlLines(
  lines: readonly string[],
  startIndex: number,
  expectedIndent: number,
): { value: YamlObject | string[]; nextIndex: number } {
  const firstNonEmpty = findNextContentLine(lines, startIndex);
  if (firstNonEmpty === -1) {
    return { value: {}, nextIndex: lines.length };
  }

  const firstLine = lines[firstNonEmpty] ?? '';
  if (firstLine.trimStart().startsWith('- ')) {
    const items: string[] = [];
    let i = firstNonEmpty;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        i += 1;
        continue;
      }
      const indent = getIndent(line);
      if (indent < expectedIndent || !trimmed.startsWith('- ')) {
        break;
      }
      items.push(unquoteYamlScalar(trimmed.slice(2)));
      i += 1;
    }
    return { value: items, nextIndex: i };
  }

  const result: YamlObject = {};
  let i = firstNonEmpty;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    const indent = getIndent(line);
    if (indent < expectedIndent) {
      break;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid YAML frontmatter line: ${line}`);
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const rawValue = trimmed.slice(colonIndex + 1).trim();

    if (rawValue.length === 0) {
      const nextContent = findNextContentLine(lines, i + 1);
      if (nextContent !== -1) {
        const nextLine = lines[nextContent] ?? '';
        const nextIndent = getIndent(nextLine);
        if (nextIndent > indent) {
          const parsedChild = parseYamlLines(lines, nextContent, nextIndent);
          result[key] = parsedChild.value;
          i = parsedChild.nextIndex;
          continue;
        }
      }
      result[key] = '';
      i += 1;
      continue;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      result[key] = parseInlineArray(rawValue);
    } else {
      result[key] = unquoteYamlScalar(rawValue);
    }
    i += 1;
  }

  return { value: result, nextIndex: i };
}

function parseSkillMarkdown(markdown: string): ParsedSkill {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new Error('SKILL.md is missing valid YAML frontmatter delimited by ---');
  }
  const frontmatterRaw = match[1] ?? '';
  const body = match[2] ?? '';
  const parsed = parseYamlLines(frontmatterRaw.split('\n'), 0, 0);
  if (Array.isArray(parsed.value)) {
    throw new Error('SKILL.md frontmatter root must be a YAML mapping');
  }
  return {
    frontmatter: parsed.value,
    body,
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
      stdout: (line: string) => {
        stdout.push(line);
      },
      stderr: (line: string) => {
        stderr.push(line);
      },
    },
  };
}

describe('generic Preflight Agent Skill (skills/preflight/SKILL.md)', () => {
  const rawSkill = readFileSync(SKILL_PATH, 'utf8');
  const { frontmatter, body } = parseSkillMarkdown(rawSkill);

  it('defines valid agent-agnostic YAML frontmatter with OpenClaw bin compatibility', () => {
    expect(frontmatter['name']).toBe('preflight');
    const description = frontmatter['description'];
    expect(typeof description).toBe('string');
    if (typeof description === 'string') {
      expect(description.trim().length).toBeGreaterThan(10);
    }
    expect(frontmatter['version']).toBe('0.1.0');

    const allowedTools = frontmatter['allowed-tools'];
    expect(Array.isArray(allowedTools)).toBe(true);
    expect(allowedTools).toContain('exec');

    const metadata = frontmatter['metadata'];
    expect(isYamlObject(metadata)).toBe(true);
    if (isYamlObject(metadata)) {
      const openclaw = metadata['openclaw'];
      expect(isYamlObject(openclaw)).toBe(true);
      if (isYamlObject(openclaw)) {
        const requires = openclaw['requires'];
        expect(isYamlObject(requires)).toBe(true);
        if (isYamlObject(requires)) {
          expect(requires['bins']).toEqual(['preflight']);
        }
      }
    }
  });

  it('documents the live Phase 1 preflight check --json workflow, fallbacks, verbatim output, and factual verdicts', () => {
    expect(body).toContain('preflight check --json');
    expect(body).toContain('preflight check');
    expect(body).toContain('node dist/cli.js check --json');
    expect(body).toContain('npx --no-install preflight check --json');
    expect(body).toContain('preflight explain');
    expect(body).toContain('preflight init --hook');
    expect(body.toLowerCase()).toContain('verbatim');
    expect(body).toContain('stdout');
    expect(body).toContain('stderr');
    expect(body).toContain('these checks passed');
    expect(body).toContain('these checks failed');
    expect(body).not.toContain('Foundation Stub');
    expect(body).not.toContain('not implemented');
    expect(body.toLowerCase()).not.toContain('ci will pass');
  });
});

describe('agent setup documentation (docs/agent-setup.md)', () => {
  const agentSetupDoc = readFileSync(AGENT_SETUP_PATH, 'utf8');

  it('documents local Ollama default, PREFLIGHT_PROVIDER presets, all CLI commands, and secret hygiene', () => {
    expect(agentSetupDoc).toContain('ollama');
    expect(agentSetupDoc).toContain('http://localhost:11434/v1');
    expect(agentSetupDoc).toContain('qwen2.5-coder:7b');
    expect(agentSetupDoc).toContain('PREFLIGHT_PROVIDER');
    expect(agentSetupDoc).toContain('PREFLIGHT_API_KEY');
    for (const preset of ['groq', 'gemini', 'openrouter', 'openai', 'cerebras', 'custom']) {
      expect(agentSetupDoc).toContain(preset);
    }
    expect(agentSetupDoc).toContain('.env');
    expect(agentSetupDoc).toContain('preflight check --json');
    expect(agentSetupDoc).toContain('preflight explain');
    expect(agentSetupDoc).toContain('preflight init --hook');
    expect(agentSetupDoc).toContain('preflight bench --out bench/results');
    expect(agentSetupDoc).toContain('pre-push');
    expect(agentSetupDoc).not.toContain('not implemented');
    expect(agentSetupDoc).not.toContain('Current Foundation Status');
    expect(agentSetupDoc).not.toContain('Planned in Phase 1');
    expect(agentSetupDoc.toLowerCase()).not.toContain('ci will pass');
  });

  it('documents the post-edit agent loop reading verdict, verify.results[], and think.likely_failures[]', () => {
    expect(agentSetupDoc).toContain('verdict');
    expect(agentSetupDoc).toContain('passed');
    expect(agentSetupDoc).toContain('failed');
    expect(agentSetupDoc).toContain('no_checks_run');
    expect(agentSetupDoc).toContain('verify.results');
    expect(agentSetupDoc).toContain('think.likely_failures');
  });

  it('documents multiple coding agents including Claude Code, Codex, Cursor, and OpenClaw', () => {
    expect(agentSetupDoc).toContain('Claude Code');
    expect(agentSetupDoc).toContain('Codex');
    expect(agentSetupDoc).toContain('Cursor');
    expect(agentSetupDoc).toContain('OpenClaw');
    expect(agentSetupDoc).toContain('openclaw skills info preflight');
    expect(agentSetupDoc).toContain('Antigravity');
  });
});

describe('skill and setup docs hygiene', () => {
  const docsToAudit: ReadonlyArray<{ label: string; content: string }> = [
    { label: 'skills/preflight/SKILL.md', content: readFileSync(SKILL_PATH, 'utf8') },
    { label: 'docs/agent-setup.md', content: readFileSync(AGENT_SETUP_PATH, 'utf8') },
  ];

  it.each(docsToAudit)(
    '$label contains zero hardcoded secrets and zero banned legacy strings',
    ({ content }) => {
      const lowered = content.toLowerCase();
      for (const banned of BANNED_STRINGS) {
        expect(lowered).not.toContain(banned);
      }
      for (const secretPattern of SECRET_PATTERNS) {
        expect(content).not.toMatch(secretPattern);
      }
    },
  );
});

describe('Preflight CLI smoke execution', () => {
  it('runs runCli(["--help"]) and prints full CLI usage with exit code 0', async () => {
    const captured = createCapturedIo();
    const exitCode = await runCli(['--help'], captured.io);
    const output = captured.stdout.join('\n');

    expect(exitCode).toBe(0);
    expect(output).toContain('Usage: preflight <command>');
    expect(output).toContain('check');
    expect(output).toContain('explain <log>');
    expect(output).toContain('init --hook');
    expect(output).toContain('bench');
    expect(output).not.toContain('not implemented');
    expect(captured.stderr).toEqual([]);
  });

  it.runIf(existsSync(DIST_CLI_PATH))(
    'executes built node dist/cli.js --help with exit code 0',
    () => {
      const result = spawnSync(process.execPath, [DIST_CLI_PATH, '--help'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage: preflight <command>');
      expect(result.stderr).toBe('');
    },
  );
});
