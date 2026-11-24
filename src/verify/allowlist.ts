import { posix as posixPath } from 'node:path';
import type {
  AllowlistDecision,
  TokenizeResult,
  VerifyWorkflowCommand,
} from './types.js';

const UNQUOTED_FORBIDDEN_CHARS: ReadonlySet<string> = new Set([
  ';',
  '|',
  '&',
  '`',
  '$',
  '>',
  '<',
  '(',
  ')',
  '\\',
]);

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const PYTHON_BINARY_RE = /^python(3(\.\d+)?)?$/;
const SUBCOMMAND_TOKEN_RE = /^[a-z][a-z0-9_-]*$/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[/\\]/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const NON_NEGATIVE_INT_RE = /^\d+$/;
const SAFE_RULE_LIST_RE = /^[A-Za-z0-9_,.-]+$/;

const MULTI_SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set([
  'vitest',
  'ruff',
  'tox',
  'biome',
  'cargo',
  'go',
  'dotnet',
  'npm',
  'pnpm',
  'yarn',
  'uv',
  'poetry',
  'pdm',
  'hatch',
  'pip',
  'pip3',
  'bun',
  'deno',
  'gradle',
  'mvn',
  'git',
  'docker',
  'gh',
]);

const INTERPRETER_BASENAMES: ReadonlySet<string> = new Set([
  'node',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'ruby',
  'perl',
  'php',
  'cmd',
  'powershell',
  'pwsh',
]);

const DANGEROUS_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-c',
  '--exec',
  '--command',
  '--code',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--preload',
  '--plugin',
  '--plugins',
  '--setupFiles',
  '--setupFilesAfterEnv',
  '--globalSetup',
  '--globalTeardown',
  '--resolver',
  '--runner',
  '--testRunner',
  '--testEnvironment',
  '--preset',
  '--transform',
  '--moduleNameMapper',
  '--config',
  '--config-file',
  '--rcfile',
  '--project',
  '--tsconfig',
  '--root',
  '--rootDir',
  '--rootdir',
  '--cwd',
  '--prefix',
  '--chdir',
  '-C',
  '--dir',
  '--workdir',
  '--directory',
  '--confdir',
  '--override-ini',
  '-o',
  '--fix',
  '--fix-unsafe',
  '--unsafe-fixes',
  '--write',
  '--output',
  '--outFile',
  '--outDir',
  '--outfile',
  '--outdir',
  '--outputFile',
  '--output-file',
  '--junitxml',
  '--html',
  '--log-file',
  '--cache-file',
  '--cache-location',
  '--update',
  '-u',
  '--updateSnapshot',
  '--update-snapshots',
  '--package',
  '--registry',
  '--index-url',
  '--extra-index-url',
  '--find-links',
  '--shell',
  '--script-shell',
  '--yes',
  '-y',
]);

const SAFE_STANDALONE_FLAGS: ReadonlySet<string> = new Set([
  '--run',
  '--no-watch',
  '--bail',
  '-b',
  '-x',
  '--exitfirst',
  '-q',
  '-qq',
  '--quiet',
  '-v',
  '-vv',
  '-vvv',
  '--verbose',
  '-s',
  '--silent',
  '--no-header',
  '--no-summary',
  '--no-cov',
  '--no-cache',
  '--no-color',
  '--color',
  '--no-colors',
  '--passWithNoTests',
  '--pass-with-no-tests',
  '--runInBand',
  '-i',
  '--ci',
  '--onlyChanged',
  '--findRelatedTests',
  '--exit',
  '--fail-fast',
  '--ff',
  '--lf',
  '--last-failed',
  '--nf',
  '--new-first',
  '--sw',
  '--stepwise',
  '--strict',
  '--strict-markers',
  '--strict-config',
  '--collect-only',
  '--co',
  '--list',
  '--show-error-codes',
  '--no-error-summary',
  '--no-incremental',
  '--pretty',
  '--no-pretty',
  '--no-color-output',
  '--ignore-missing-imports',
  '--noEmit',
  '--skipLibCheck',
  '--check',
  '--diff',
  '--no-fix',
  '--exit-zero',
  '--statistics',
  '--show-fixes',
  '--no-show-fixes',
  '--no-warn-ignored',
  '--no-error-on-unmatched-pattern',
]);

const SAFE_PATTERN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-t',
  '--testNamePattern',
  '--test-name-pattern',
  '-g',
  '--grep',
  '--fgrep',
  '-k',
  '-m',
]);

const SAFE_PATH_PATTERN_FLAGS: ReadonlySet<string> = new Set([
  '--testPathPattern',
  '--test-path-pattern',
]);

const SAFE_NUMERIC_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--maxfail',
  '--max-warnings',
  '--timeout',
  '--testTimeout',
  '--test-timeout',
  '--retries',
  '--maxWorkers',
  '--max-workers',
  '--maxConcurrency',
  '--max-concurrency',
  '--durations',
  '--bail',
]);

const SAFE_RULE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--select',
  '--ignore',
  '--extend-select',
  '--rule',
]);

const SAFE_ENUM_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['--tb', new Set(['auto', 'long', 'short', 'line', 'native', 'no'])],
  ['--capture', new Set(['no', 'sys', 'fd', 'tee-sys'])],
  ['--color', new Set(['yes', 'no', 'auto'])],
  ['--pretty', new Set(['true', 'false'])],
  ['--watch', new Set(['false'])],
  ['--watchAll', new Set(['false'])],
  ['--incremental', new Set(['false'])],
  ['--composite', new Set(['false'])],
  ['--follow-imports', new Set(['normal', 'silent', 'skip', 'error'])],
  [
    '--reporter',
    new Set([
      'spec',
      'dot',
      'list',
      'tap',
      'json',
      'min',
      'verbose',
      'basic',
      'default',
      'summary',
      'nyan',
      'progress',
    ]),
  ],
  [
    '--reporters',
    new Set([
      'spec',
      'dot',
      'list',
      'tap',
      'json',
      'min',
      'verbose',
      'basic',
      'default',
      'summary',
      'nyan',
      'progress',
    ]),
  ],
  [
    '-R',
    new Set([
      'spec',
      'dot',
      'list',
      'tap',
      'json',
      'min',
      'verbose',
      'basic',
      'default',
      'summary',
      'nyan',
      'progress',
    ]),
  ],
  [
    '--output-format',
    new Set(['concise', 'full', 'grouped', 'json', 'github', 'text', 'unix']),
  ],
  [
    '--format',
    new Set(['compact', 'stylish', 'json', 'unix', 'concise', 'full', 'grouped', 'github', 'text']),
  ],
  [
    '-f',
    new Set(['compact', 'stylish', 'json', 'unix', 'concise', 'full', 'grouped', 'github', 'text']),
  ],
]);

interface ParsedSignature {
  signature: string[];
  consumed: number;
  allowScoping: boolean;
}

interface ParsedBaseline {
  rawWorkflowCommand: string;
  workingDirectory?: string;
  tokens: string[];
  signature: string[];
  consumed: number;
  allowScoping: boolean;
}

export function tokenizeCommand(command: string): TokenizeResult {
  if (command.includes('\n') || command.includes('\r')) {
    return {
      ok: false,
      reason: 'Command contains disallowed newline characters',
    };
  }
  if (command.includes('\0')) {
    return {
      ok: false,
      reason: 'Command contains disallowed NUL character',
    };
  }
  if (command.trim().length === 0) {
    return { ok: false, reason: 'Command is empty' };
  }

  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === undefined) {
      continue;
    }

    if (ch === '`') {
      return {
        ok: false,
        reason: 'Disallowed shell metacharacter "`" (command substitution) in command',
      };
    }
    if (ch === '$' && command[i + 1] === '(') {
      return {
        ok: false,
        reason: 'Disallowed shell metacharacter "$(" (command substitution) in command',
      };
    }
    if (ch === '$' && command[i + 1] === '{') {
      return {
        ok: false,
        reason: 'Disallowed shell metacharacter "${" (variable expansion) in command',
      };
    }

    if (quote === null) {
      if (ch === ' ' || ch === '\t') {
        if (inToken) {
          tokens.push(current);
          current = '';
          inToken = false;
        }
        continue;
      }

      if (ch === "'" || ch === '"') {
        quote = ch;
        inToken = true;
        continue;
      }

      if (UNQUOTED_FORBIDDEN_CHARS.has(ch)) {
        const next = command[i + 1];
        if (ch === '&' && next === '&') {
          return {
            ok: false,
            reason: 'Disallowed shell operator "&&" in command',
          };
        }
        if (ch === '|' && next === '|') {
          return {
            ok: false,
            reason: 'Disallowed shell operator "||" in command',
          };
        }
        return {
          ok: false,
          reason: `Disallowed shell metacharacter "${ch}" in command`,
        };
      }

      if (!inToken && ch === '~') {
        return {
          ok: false,
          reason: 'Disallowed shell tilde expansion "~" in command',
        };
      }

      current += ch;
      inToken = true;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    // Inside double quotes
    if (ch === '"') {
      quote = null;
      continue;
    }
    if (ch === '$') {
      return {
        ok: false,
        reason: 'Disallowed variable expansion "$" inside double quotes',
      };
    }
    if (ch === '\\') {
      const next = command[i + 1];
      if (next === undefined) {
        return {
          ok: false,
          reason: 'Unterminated escape sequence in command',
        };
      }
      if (next === '"' || next === '\\') {
        current += next;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    current += ch;
  }

  if (quote !== null) {
    return {
      ok: false,
      reason: `Unclosed ${quote === "'" ? 'single' : 'double'} quote in command`,
    };
  }

  if (inToken) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return { ok: false, reason: 'Command is empty' };
  }

  return { ok: true, tokens };
}

function isPythonBinary(token: string): boolean {
  return PYTHON_BINARY_RE.test(token);
}

function isInterpreterBinary(token: string): boolean {
  const base = posixPath.basename(token.replace(/\\/g, '/'));
  return INTERPRETER_BASENAMES.has(base);
}

function isNodeBinary(token: string): boolean {
  return posixPath.basename(token.replace(/\\/g, '/')) === 'node';
}

function isSubcommandToken(token: string | undefined): token is string {
  return token !== undefined && !token.startsWith('-') && SUBCOMMAND_TOKEN_RE.test(token);
}

function parseToolSignature(
  tokens: readonly string[],
  startIndex: number,
): { parts: string[]; consumed: number; allowScoping: boolean } {
  const tool = tokens[startIndex];
  if (tool === undefined || tool.startsWith('-')) {
    return { parts: [], consumed: 0, allowScoping: false };
  }

  if (isPythonBinary(tool)) {
    const next = tokens[startIndex + 1];
    const mod = tokens[startIndex + 2];
    if (next === '-m' && mod !== undefined && !mod.startsWith('-')) {
      const sub = tokens[startIndex + 3];
      if (MULTI_SUBCOMMAND_TOOLS.has(mod) && isSubcommandToken(sub)) {
        return {
          parts: ['python', '-m', mod, sub],
          consumed: 4,
          allowScoping: true,
        };
      }
      return { parts: ['python', '-m', mod], consumed: 3, allowScoping: true };
    }
    if (next !== undefined) {
      return { parts: ['python', next], consumed: 2, allowScoping: false };
    }
    return { parts: ['python'], consumed: 1, allowScoping: false };
  }

  if (isNodeBinary(tool) && tokens[startIndex + 1] === '--test') {
    return { parts: [tool, '--test'], consumed: 2, allowScoping: true };
  }

  if (isInterpreterBinary(tool)) {
    const next = tokens[startIndex + 1];
    if (next !== undefined) {
      return { parts: [tool, next], consumed: 2, allowScoping: false };
    }
    return { parts: [tool], consumed: 1, allowScoping: false };
  }

  if (MULTI_SUBCOMMAND_TOOLS.has(tool)) {
    const sub = tokens[startIndex + 1];
    if (isSubcommandToken(sub)) {
      return { parts: [tool, sub], consumed: 2, allowScoping: true };
    }
    return { parts: [tool], consumed: 1, allowScoping: true };
  }

  return { parts: [tool], consumed: 1, allowScoping: true };
}

function parseCommandSignature(tokens: readonly string[]): ParsedSignature {
  const first = tokens[0];
  if (first === undefined) {
    return { signature: [], consumed: 0, allowScoping: false };
  }

  if (first === 'npm') {
    const second = tokens[1];
    const third = tokens[2];
    if (second === 'run' || second === 'run-script') {
      if (third !== undefined && !third.startsWith('-')) {
        return {
          signature: ['npm', 'run', third],
          consumed: 3,
          allowScoping: true,
        };
      }
      return { signature: ['npm', 'run'], consumed: 2, allowScoping: false };
    }
    if (second === 'test' || second === 't' || second === 'tst') {
      return { signature: ['npm', 'test'], consumed: 2, allowScoping: true };
    }
    if (second === 'exec') {
      let idx = 2;
      if (tokens[idx] === '--') {
        idx += 1;
      }
      const nested = parseToolSignature(tokens, idx);
      return {
        signature: ['npm', 'exec', ...nested.parts],
        consumed: idx + nested.consumed,
        allowScoping: nested.allowScoping,
      };
    }
    if (second !== undefined && !second.startsWith('-')) {
      return { signature: ['npm', second], consumed: 2, allowScoping: true };
    }
    return { signature: ['npm'], consumed: 1, allowScoping: false };
  }

  if (first === 'pnpm' || first === 'yarn') {
    const second = tokens[1];
    const third = tokens[2];
    if (second === 'run') {
      if (third !== undefined && !third.startsWith('-')) {
        return { signature: [first, third], consumed: 3, allowScoping: true };
      }
      return { signature: [first, 'run'], consumed: 2, allowScoping: false };
    }
    if (first === 'pnpm' && second === 'exec') {
      const nested = parseToolSignature(tokens, 2);
      return {
        signature: ['pnpm', 'exec', ...nested.parts],
        consumed: 2 + nested.consumed,
        allowScoping: nested.allowScoping,
      };
    }
    if (second !== undefined && !second.startsWith('-')) {
      if (MULTI_SUBCOMMAND_TOOLS.has(second) && isSubcommandToken(third)) {
        return {
          signature: [first, second, third],
          consumed: 3,
          allowScoping: true,
        };
      }
      return { signature: [first, second], consumed: 2, allowScoping: true };
    }
    return { signature: [first], consumed: 1, allowScoping: false };
  }

  if (first === 'npx' || first === 'bunx') {
    let idx = 1;
    while (tokens[idx] === '--no-install' || tokens[idx] === '--no') {
      idx += 1;
    }
    const nested = parseToolSignature(tokens, idx);
    return {
      signature: [first, ...nested.parts],
      consumed: idx + nested.consumed,
      allowScoping: nested.allowScoping,
    };
  }

  if (first === 'uv' || first === 'poetry' || first === 'pdm') {
    const second = tokens[1];
    if (second === 'run') {
      const nested = parseToolSignature(tokens, 2);
      return {
        signature: [first, 'run', ...nested.parts],
        consumed: 2 + nested.consumed,
        allowScoping: nested.allowScoping,
      };
    }
    if (isSubcommandToken(second)) {
      return { signature: [first, second], consumed: 2, allowScoping: true };
    }
    return { signature: [first], consumed: 1, allowScoping: false };
  }

  if (first === 'bun') {
    const second = tokens[1];
    const third = tokens[2];
    if (second === 'run' && third !== undefined && !third.startsWith('-')) {
      return {
        signature: ['bun', 'run', third],
        consumed: 3,
        allowScoping: true,
      };
    }
    if (isSubcommandToken(second)) {
      return { signature: ['bun', second], consumed: 2, allowScoping: true };
    }
    return { signature: ['bun'], consumed: 1, allowScoping: false };
  }

  const parsed = parseToolSignature(tokens, 0);
  return {
    signature: parsed.parts,
    consumed: parsed.consumed,
    allowScoping: parsed.allowScoping,
  };
}

export function extractCommandSignature(tokens: readonly string[]): string[] {
  return parseCommandSignature(tokens).signature;
}

export function hasPathTraversal(value: string): boolean {
  const candidates = [value];
  const eqIdx = value.indexOf('=');
  if (eqIdx !== -1) {
    candidates.push(value.slice(eqIdx + 1));
  }

  for (const part of candidates) {
    if (part === '..') {
      return true;
    }
    const segments = part.split(/[/\\]/);
    if (segments.includes('..')) {
      return true;
    }
  }
  return false;
}

function isAbsoluteOrHomePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('~') ||
    WINDOWS_DRIVE_RE.test(value)
  );
}

function validateSafeRepoRelativePath(value: string): string | null {
  if (value.length === 0) {
    return 'Empty path argument is not allowed';
  }
  if (hasPathTraversal(value)) {
    return `Path traversal ("..") is not allowed in argument "${value}"`;
  }
  if (isAbsoluteOrHomePath(value)) {
    return `Absolute or home path "${value}" is not allowed outside repository`;
  }
  if (URL_SCHEME_RE.test(value)) {
    return `URL argument "${value}" is not allowed`;
  }
  if (ENV_ASSIGNMENT_RE.test(value)) {
    return `Inline environment assignment "${value}" is not allowed`;
  }
  if (value.includes('\\')) {
    return `Backslash path "${value}" is not allowed`;
  }
  return null;
}

function splitBaselineSegments(rawCommand: string): string[] {
  const segments: string[] = [];
  const lines = rawCommand.split(/\r?\n/);

  for (const line of lines) {
    let current = '';
    let quote: "'" | '"' | null = null;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === undefined) {
        continue;
      }

      if (quote === null) {
        if (ch === "'" || ch === '"') {
          quote = ch;
          current += ch;
          continue;
        }
        if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
          break;
        }
        if (ch === '&' && line[i + 1] === '&') {
          if (current.trim().length > 0) {
            segments.push(current.trim());
          }
          current = '';
          i += 1;
          continue;
        }
        if (ch === '|' || ch === ';' || ch === '>' || ch === '<') {
          break;
        }
        current += ch;
        continue;
      }

      if (quote === "'") {
        if (ch === "'") {
          quote = null;
        }
        current += ch;
        continue;
      }

      if (ch === '\\' && line[i + 1] !== undefined) {
        current += ch + (line[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === '"') {
        quote = null;
      }
      current += ch;
    }

    if (current.trim().length > 0) {
      segments.push(current.trim());
    }
  }

  return segments;
}

function stripLeadingEnvTokens(tokens: readonly string[]): string[] {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === undefined || !ENV_ASSIGNMENT_RE.test(tok)) {
      break;
    }
    idx += 1;
  }
  return tokens.slice(idx);
}

function parseWorkflowBaselines(
  workflowCommands: readonly VerifyWorkflowCommand[],
): ParsedBaseline[] {
  const baselines: ParsedBaseline[] = [];

  for (const wf of workflowCommands) {
    const segments = splitBaselineSegments(wf.command);
    for (const segment of segments) {
      const tokenized = tokenizeCommand(segment);
      if (!tokenized.ok) {
        continue;
      }
      const envFree = stripLeadingEnvTokens(tokenized.tokens);
      if (envFree.length === 0) {
        continue;
      }
      const parsed = parseCommandSignature(envFree);
      if (parsed.signature.length === 0) {
        continue;
      }
      const baseline: ParsedBaseline = {
        rawWorkflowCommand: wf.command,
        tokens: envFree,
        signature: parsed.signature,
        consumed: parsed.consumed,
        allowScoping: parsed.allowScoping,
      };
      if (wf.workingDirectory !== undefined) {
        baseline.workingDirectory = wf.workingDirectory;
      }
      baselines.push(baseline);
    }
  }

  return baselines;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function validateFlagValue(flagName: string, value: string): string | null {
  if (value.length === 0) {
    return `Flag "${flagName}" requires a non-empty value`;
  }
  if (hasPathTraversal(value)) {
    return `Path traversal ("..") is not allowed in value for "${flagName}"`;
  }

  if (SAFE_PATTERN_VALUE_FLAGS.has(flagName)) {
    return null;
  }

  if (SAFE_PATH_PATTERN_FLAGS.has(flagName)) {
    return validateSafeRepoRelativePath(value);
  }

  if (SAFE_NUMERIC_VALUE_FLAGS.has(flagName)) {
    if (!NON_NEGATIVE_INT_RE.test(value)) {
      return `Flag "${flagName}" requires a non-negative integer value (got "${value}")`;
    }
    return null;
  }

  if (flagName === '-n') {
    if (value === 'auto' || NON_NEGATIVE_INT_RE.test(value)) {
      return null;
    }
    return `Flag "-n" requires "auto" or a non-negative integer value (got "${value}")`;
  }

  if (SAFE_RULE_VALUE_FLAGS.has(flagName)) {
    if (!SAFE_RULE_LIST_RE.test(value)) {
      return `Flag "${flagName}" contains disallowed characters in value "${value}"`;
    }
    return null;
  }

  const allowedEnum = SAFE_ENUM_VALUE_FLAGS.get(flagName);
  if (allowedEnum !== undefined) {
    if (!allowedEnum.has(value)) {
      return `Disallowed value "${value}" for flag "${flagName}"`;
    }
    return null;
  }

  return `Disallowed flag "${flagName}"`;
}

function isSafeValueFlag(flagName: string): boolean {
  return (
    SAFE_PATTERN_VALUE_FLAGS.has(flagName) ||
    SAFE_PATH_PATTERN_FLAGS.has(flagName) ||
    SAFE_NUMERIC_VALUE_FLAGS.has(flagName) ||
    SAFE_RULE_VALUE_FLAGS.has(flagName) ||
    SAFE_ENUM_VALUE_FLAGS.has(flagName) ||
    flagName === '-n'
  );
}

function validateScopedArguments(
  candidateExtraArgs: readonly string[],
  baselineExtraArgs: readonly string[],
): string | null {
  const baselineTokenSet = new Set(baselineExtraArgs);
  const baselinePairSet = new Set<string>();
  for (let i = 0; i + 1 < baselineExtraArgs.length; i += 1) {
    const left = baselineExtraArgs[i];
    const right = baselineExtraArgs[i + 1];
    if (left !== undefined && right !== undefined && left.startsWith('-')) {
      baselinePairSet.add(`${left}\0${right}`);
    }
  }

  for (let i = 0; i < candidateExtraArgs.length; i += 1) {
    const arg = candidateExtraArgs[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.length === 0) {
      return 'Empty argument is not allowed';
    }
    if (arg === '--') {
      continue;
    }

    if (arg.startsWith('-')) {
      const next = candidateExtraArgs[i + 1];
      if (next !== undefined && baselinePairSet.has(`${arg}\0${next}`)) {
        i += 1;
        continue;
      }

      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const flagName = arg.slice(0, eqIdx);
        const flagVal = arg.slice(eqIdx + 1);
        if (baselineTokenSet.has(arg)) {
          continue;
        }
        if (DANGEROUS_FLAGS.has(flagName)) {
          return `Disallowed dangerous flag "${flagName}" (not present verbatim in CI workflow command)`;
        }
        if (!isSafeValueFlag(flagName)) {
          return `Disallowed flag "${flagName}" (not present in CI workflow command or scoping allowlist)`;
        }
        const valueError = validateFlagValue(flagName, flagVal);
        if (valueError !== null) {
          return valueError;
        }
        continue;
      }

      // Bare flag (no '=')
      if (baselineTokenSet.has(arg) && !DANGEROUS_FLAGS.has(arg)) {
        continue;
      }
      if (DANGEROUS_FLAGS.has(arg)) {
        return `Disallowed dangerous flag "${arg}" (not present verbatim in CI workflow command)`;
      }

      if (SAFE_STANDALONE_FLAGS.has(arg)) {
        // Handle flags that can be either boolean or value-taking (e.g. --bail, --pretty, --color)
        if (
          isSafeValueFlag(arg) &&
          next !== undefined &&
          !next.startsWith('-') &&
          validateFlagValue(arg, next) === null
        ) {
          i += 1;
        }
        continue;
      }

      if (isSafeValueFlag(arg)) {
        if (next === undefined || next.startsWith('-')) {
          return `Flag "${arg}" requires a value`;
        }
        const valueError = validateFlagValue(arg, next);
        if (valueError !== null) {
          return valueError;
        }
        i += 1;
        continue;
      }

      return `Disallowed flag "${arg}" (not present in CI workflow command or scoping allowlist)`;
    }

    // Positional argument: allow if verbatim in baseline (still checked for path traversal globally)
    // or if it is a safe repo-relative path / test target.
    if (baselineTokenSet.has(arg)) {
      continue;
    }

    const pathError = validateSafeRepoRelativePath(arg);
    if (pathError !== null) {
      return pathError;
    }
  }

  return null;
}

function buildAllowedDecision(
  candidateTokens: readonly string[],
  baseline: ParsedBaseline,
): AllowlistDecision {
  const binary = candidateTokens[0];
  if (binary === undefined) {
    return { allowed: false, reason: 'Command is empty' };
  }

  if (
    baseline.workingDirectory !== undefined &&
    (hasPathTraversal(baseline.workingDirectory) ||
      isAbsoluteOrHomePath(baseline.workingDirectory))
  ) {
    return {
      allowed: false,
      reason: `Unsafe workflow workingDirectory "${baseline.workingDirectory}"`,
    };
  }

  const decision: AllowlistDecision = {
    allowed: true,
    binary,
    args: candidateTokens.slice(1),
    matchedWorkflowCommand: baseline.rawWorkflowCommand,
  };
  if (baseline.workingDirectory !== undefined) {
    decision.workingDirectory = baseline.workingDirectory;
  }
  return decision;
}

export function checkCommandAllowlist(
  candidate: string,
  workflowCommands: readonly VerifyWorkflowCommand[],
): AllowlistDecision {
  if (workflowCommands.length === 0) {
    return {
      allowed: false,
      reason: 'No CI workflow commands found; refusing to execute unverified commands',
    };
  }

  const tokenized = tokenizeCommand(candidate);
  if (!tokenized.ok) {
    return { allowed: false, reason: tokenized.reason };
  }

  const candidateTokens = tokenized.tokens;
  const binary = candidateTokens[0];
  if (binary === undefined || binary.length === 0) {
    return { allowed: false, reason: 'Command is empty' };
  }

  if (ENV_ASSIGNMENT_RE.test(binary)) {
    return {
      allowed: false,
      reason: `Disallowed inline environment assignment "${binary}" in command`,
    };
  }

  for (const token of candidateTokens) {
    if (hasPathTraversal(token)) {
      return {
        allowed: false,
        reason: `Path traversal ("..") is not allowed in argument "${token}"`,
      };
    }
  }

  const baselines = parseWorkflowBaselines(workflowCommands);
  if (baselines.length === 0) {
    return {
      allowed: false,
      reason: 'No valid CI workflow commands found; refusing to execute unverified commands',
    };
  }

  // 1. Exact token match against any env-free baseline workflow command
  for (const baseline of baselines) {
    if (arraysEqual(candidateTokens, baseline.tokens)) {
      return buildAllowedDecision(candidateTokens, baseline);
    }
  }

  // 2. Same normalized tool + subcommand signature with safe scoping arguments
  const candidateParsed = parseCommandSignature(candidateTokens);
  if (!candidateParsed.allowScoping) {
    return {
      allowed: false,
      reason: `Command "${candidateParsed.signature.join(' ')}" requires an exact match to a CI workflow command`,
    };
  }

  const candidateExtraArgs = candidateTokens.slice(candidateParsed.consumed);

  let firstValidationError: string | null = null;
  let matchedAnySignature = false;

  for (const baseline of baselines) {
    if (
      !baseline.allowScoping ||
      !arraysEqual(candidateParsed.signature, baseline.signature)
    ) {
      continue;
    }
    matchedAnySignature = true;

    const baselineExtraArgs = baseline.tokens.slice(baseline.consumed);
    const validationError = validateScopedArguments(
      candidateExtraArgs,
      baselineExtraArgs,
    );
    if (validationError === null) {
      return buildAllowedDecision(candidateTokens, baseline);
    }
    if (firstValidationError === null) {
      firstValidationError = validationError;
    }
  }

  if (matchedAnySignature && firstValidationError !== null) {
    return { allowed: false, reason: firstValidationError };
  }

  return {
    allowed: false,
    reason: `Command "${candidateParsed.signature.join(' ')}" does not match any CI workflow command`,
  };
}
