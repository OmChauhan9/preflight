import { existsSync, realpathSync, statSync } from 'node:fs';
import {
  isAbsolute,
  posix as posixPath,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  AllowlistDecision,
  CheckAllowlistOptions,
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
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
const URL_SCHEME_RE =
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/|[/\\])|git\+|(?:file|data|javascript|vbscript|blob|node|npm|jsr|bun|deno|github|gitlab|bitbucket):)/i;
const REMOTE_HOST_PATH_RE =
  /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|sh|gg|co|edu|gov|in|land|app)|localhost)(?::\d+)?\//i;
const NON_NEGATIVE_INT_RE = /^\d+$/;
const SAFE_RULE_LIST_RE = /^[A-Za-z0-9_,.-]+$/;

const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  'cd',
  'export',
  'set',
  'unset',
  'pushd',
  'popd',
  'source',
  '.',
  'echo',
  'true',
  'false',
  'pwd',
  'umask',
  'alias',
  'unalias',
  'eval',
  'exec',
  'shift',
  'exit',
  'return',
  'local',
  'readonly',
  'declare',
  'trap',
  ':',
]);

const DISALLOWED_BARE_ACTION_WORDS: ReadonlySet<string> = new Set([
  'deploy',
  'publish',
  'unpublish',
  'release',
  'install',
  'uninstall',
  'reinstall',
  'remove',
  'rm',
  'delete',
  'destroy',
  'clean',
  'purge',
  'fix',
  'autofix',
  'exec',
  'eval',
  'run',
  'shell',
  'sh',
  'bash',
  'init',
  'create',
  'upgrade',
  'update',
  'add',
  'link',
  'unlink',
  'login',
  'logout',
  'auth',
  'push',
  'pull',
  'fetch',
  'clone',
  'apply',
  'migrate',
  'seed',
  'drop',
  'reset',
  'format',
  'fmt',
  'write',
  'edit',
  'patch',
  'audit',
  'set',
  'config',
]);

const SCOPEABLE_SINGLE_TOOLS: ReadonlySet<string> = new Set([
  'pytest',
  'py.test',
  'jest',
  'mocha',
  'ava',
  'tap',
  'uvu',
  'jasmine',
  'tape',
  'eslint',
  'tsc',
  'prettier',
  'oxlint',
  'stylelint',
  'tslint',
  'standard',
  'xo',
  'svelte-check',
  'vue-tsc',
  'mypy',
  'pyright',
  'basedpyright',
  'flake8',
  'pylint',
  'pycodestyle',
  'pyflakes',
  'pydocstyle',
  'bandit',
  'isort',
  'black',
  'yapf',
  'vulture',
  'radon',
  'nose2',
  'nosetests',
  'behave',
  'shellcheck',
  'hadolint',
  'yamllint',
  'markdownlint',
  'rubocop',
  'rspec',
  'phpunit',
  'phpstan',
  'psalm',
]);

interface MultiToolSpec {
  scopeableSubcommands: ReadonlySet<string>;
  nonScopeableSubcommands?: ReadonlySet<string>;
  allowBareScoping: boolean;
}

const SCOPEABLE_MULTI_TOOLS: ReadonlyMap<string, MultiToolSpec> = new Map([
  [
    'vitest',
    {
      scopeableSubcommands: new Set(['run', 'related', 'typecheck']),
      nonScopeableSubcommands: new Set(['watch', 'dev', 'bench', 'init', 'list']),
      allowBareScoping: true,
    },
  ],
  [
    'ruff',
    {
      scopeableSubcommands: new Set(['check', 'format']),
      allowBareScoping: false,
    },
  ],
  [
    'tox',
    {
      scopeableSubcommands: new Set(['run']),
      allowBareScoping: true,
    },
  ],
  [
    'biome',
    {
      scopeableSubcommands: new Set(['check', 'lint', 'ci', 'format']),
      allowBareScoping: false,
    },
  ],
  [
    'cargo',
    {
      scopeableSubcommands: new Set(['test', 'check', 'clippy', 'fmt']),
      allowBareScoping: false,
    },
  ],
  [
    'go',
    {
      scopeableSubcommands: new Set(['test', 'vet']),
      allowBareScoping: false,
    },
  ],
  [
    'dotnet',
    {
      scopeableSubcommands: new Set(['test']),
      allowBareScoping: false,
    },
  ],
  [
    'deno',
    {
      scopeableSubcommands: new Set(['test', 'check', 'lint', 'fmt']),
      allowBareScoping: false,
    },
  ],
  [
    'pre-commit',
    {
      scopeableSubcommands: new Set(['run']),
      allowBareScoping: false,
    },
  ],
  [
    'playwright',
    {
      scopeableSubcommands: new Set(['test']),
      allowBareScoping: false,
    },
  ],
  [
    'cypress',
    {
      scopeableSubcommands: new Set(['run']),
      allowBareScoping: false,
    },
  ],
  [
    'golangci-lint',
    {
      scopeableSubcommands: new Set(['run']),
      allowBareScoping: false,
    },
  ],
]);

const SCOPEABLE_PYTHON_SINGLE_MODULES: ReadonlySet<string> = new Set([
  'pytest',
  'unittest',
  'mypy',
  'flake8',
  'pylint',
  'pycodestyle',
  'pyflakes',
  'pydocstyle',
  'bandit',
  'isort',
  'black',
  'yapf',
  'vulture',
  'radon',
  'pyright',
  'basedpyright',
  'nose2',
  'behave',
  'doctest',
]);

const SCOPEABLE_PYTHON_MULTI_MODULES: ReadonlyMap<string, MultiToolSpec> =
  new Map([
    [
      'ruff',
      {
        scopeableSubcommands: new Set(['check', 'format']),
        allowBareScoping: false,
      },
    ],
    [
      'tox',
      {
        scopeableSubcommands: new Set(['run']),
        allowBareScoping: true,
      },
    ],
    [
      'pre_commit',
      {
        scopeableSubcommands: new Set(['run']),
        allowBareScoping: false,
      },
    ],
    [
      'pre-commit',
      {
        scopeableSubcommands: new Set(['run']),
        allowBareScoping: false,
      },
    ],
  ]);

const EXACT_MATCH_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'uvx',
  'pipx',
  'pipenv',
  'bundle',
  'pnpx',
  'changeset',
  'lerna',
  'turbo',
  'nx',
  'mvn',
  'mvnw',
  'gradle',
  'gradlew',
  'hatch',
  'make',
  'gmake',
  'nmake',
  'cmake',
  'just',
  'task',
  'rake',
  'ant',
  'bazel',
  'buck',
  'ninja',
  'scons',
  'invoke',
  'inv',
  'fab',
  'mise',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'ln',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'chgrp',
  'dd',
  'tar',
  'unzip',
  'zip',
  'gzip',
  'gunzip',
  'find',
  'xargs',
  'sed',
  'awk',
  'gawk',
  'tee',
  'cat',
  'head',
  'tail',
  'echo',
  'printf',
  'env',
  'eval',
  'exec',
  'sudo',
  'su',
  'kill',
  'pkill',
  'killall',
  'git',
  'gh',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'ftp',
  'nc',
  'ncat',
  'socat',
  'docker',
  'docker-compose',
  'podman',
  'kubectl',
  'helm',
  'terraform',
  'ansible',
  'aws',
  'gcloud',
  'az',
  'pip',
  'pip3',
  'apt',
  'apt-get',
  'brew',
  'choco',
  'pacman',
  'yum',
  'dnf',
]);

const PACKAGE_MANAGER_EXACT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
  'publish',
  'unpublish',
  'login',
  'logout',
  'link',
  'unlink',
  'init',
  'create',
  'dlx',
  'deploy',
  'set',
  'config',
  'patch',
  'audit',
  'pack',
  'version',
  'store',
  'env',
  'setup',
  'prune',
  'rebuild',
  'outdated',
  'why',
  'licenses',
  'import',
  'dedupe',
  'fetch',
  'server',
  'start',
  'stop',
  'restart',
  'workspaces',
  'workspace',
  'plugin',
  'npm',
  'stage',
  'constraints',
  'cache',
  'bin',
  'root',
  'doctor',
  'fund',
  'ls',
  'list',
  'self-update',
  'recursive',
  'unplug',
  'explain',
  'info',
  'search',
  'pkg',
]);

const PACKAGE_MANAGER_SCOPEABLE_SCRIPTS: ReadonlySet<string> = new Set([
  'test',
  'test-ci',
  'test:ci',
  'test:unit',
  'test:integration',
  'lint',
  'lint:check',
  'typecheck',
  'type-check',
  'check-types',
  'types',
  'check',
  'format:check',
]);

const UV_RUN_BOOL_FLAGS: ReadonlySet<string> = new Set([
  '--locked',
  '--frozen',
  '--no-sync',
  '--no-default-groups',
  '--dev',
  '--no-dev',
  '--all-extras',
  '--all-groups',
  '--all-packages',
  '--no-editable',
  '--exact',
  '--isolated',
  '--offline',
  '--no-project',
  '--no-progress',
  '--quiet',
  '-q',
  '--verbose',
  '-v',
]);

const UV_RUN_SAFE_EXTRA_BOOL_FLAGS: ReadonlySet<string> = new Set([
  '--locked',
  '--frozen',
  '--no-sync',
  '--offline',
  '--no-progress',
  '--quiet',
  '-q',
  '--verbose',
  '-v',
]);

const UV_RUN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--group',
  '--only-group',
  '--no-group',
  '--extra',
  '--python',
  '-p',
  '--with',
  '--with-editable',
  '--with-requirements',
  '--package',
  '--directory',
  '--project',
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
  '--file',
  '--plugin',
  '--plugins',
  '--rulesdir',
  '--resolve-plugins-relative-to',
  '--setupFiles',
  '--setupFilesAfterEnv',
  '--globalSetup',
  '--globalTeardown',
  '--resolver',
  '--runner',
  '--testRunner',
  '--testEnvironment',
  '--environment',
  '--env',
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
  '--exitfirst',
  '-q',
  '-qq',
  '--quiet',
  '-vv',
  '-vvv',
  '--verbose',
  '--silent',
  '--no-header',
  '--no-summary',
  '--no-cov',
  '--no-cache',
  '--no-color',
  '--color',
  '--no-colors',
  '--runInBand',
  '-i',
  '--ci',
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
  '--show-error-codes',
  '--no-error-summary',
  '--no-incremental',
  '--pretty',
  '--no-pretty',
  '--no-color-output',
  '--noEmit',
  '--check',
  '--check-only',
  '--diff',
  '--no-fix',
  '--statistics',
  '--show-fixes',
  '--no-show-fixes',
  '--no-warn-ignored',
]);

const SAFE_PATTERN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-t',
  '--testNamePattern',
  '--test-name-pattern',
  '-g',
  '--grep',
  '--fgrep',
  '-k',
]);

const PYTEST_ONLY_PATTERN_VALUE_FLAGS: ReadonlySet<string> = new Set(['-m']);

const SAFE_PATH_PATTERN_FLAGS: ReadonlySet<string> = new Set([
  '--testPathPattern',
  '--test-path-pattern',
]);

const SAFE_NUMERIC_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--maxfail',
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
  runnerFlags?: string[];
  nestedBinary?: string;
}

interface ParsedBaseline {
  rawWorkflowCommand: string;
  workingDirectory?: string;
  tokens: string[];
  signature: string[];
  consumed: number;
  allowScoping: boolean;
  runnerFlags: string[];
  nestedBinary?: string;
}

interface ResolvedCwdContext {
  repoRoot: string;
  realRepoRoot: string;
}

interface ScopedPathContext {
  effectiveCwd: string;
  realEffectiveCwd: string;
  realRepoRoot: string;
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
  const base = posixPath.basename(token.replace(/\\/g, '/'));
  return PYTHON_BINARY_RE.test(base);
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

function parseUvRunLeadingFlags(
  tokens: readonly string[],
  startIndex: number,
): { runnerFlags: string[]; nextIndex: number } {
  const runnerFlags: string[] = [];
  let idx = startIndex;

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === undefined || !tok.startsWith('-')) {
      break;
    }
    if (tok === '--') {
      runnerFlags.push(tok);
      idx += 1;
      break;
    }

    const eqIdx = tok.indexOf('=');
    if (eqIdx !== -1) {
      const flagName = tok.slice(0, eqIdx);
      if (UV_RUN_VALUE_FLAGS.has(flagName)) {
        runnerFlags.push(tok);
        idx += 1;
        continue;
      }
      break;
    }

    if (UV_RUN_BOOL_FLAGS.has(tok)) {
      runnerFlags.push(tok);
      idx += 1;
      continue;
    }

    if (UV_RUN_VALUE_FLAGS.has(tok)) {
      const val = tokens[idx + 1];
      if (val === undefined || val.startsWith('-')) {
        break;
      }
      runnerFlags.push(tok, val);
      idx += 2;
      continue;
    }

    break;
  }

  return { runnerFlags, nextIndex: idx };
}

function hasBinaryPathQualifier(token: string): boolean {
  return (
    token.includes('/') ||
    token.includes('\\') ||
    token.includes('~') ||
    WINDOWS_DRIVE_RE.test(token)
  );
}

function parseToolSignature(
  tokens: readonly string[],
  startIndex: number,
): {
  parts: string[];
  consumed: number;
  allowScoping: boolean;
  nestedBinary?: string;
} {
  const tool = tokens[startIndex];
  if (tool === undefined || tool.startsWith('-')) {
    return { parts: [], consumed: 0, allowScoping: false };
  }

  const toolBase = posixPath.basename(tool.replace(/\\/g, '/'));

  if (isPythonBinary(tool)) {
    const next = tokens[startIndex + 1];
    const mod = tokens[startIndex + 2];
    if (next === '-m' && mod !== undefined && !mod.startsWith('-')) {
      const sub = tokens[startIndex + 3];
      if (EXACT_MATCH_ONLY_TOOLS.has(mod)) {
        if (isSubcommandToken(sub)) {
          return {
            parts: [tool, '-m', mod, sub],
            consumed: 4,
            allowScoping: false,
            nestedBinary: tool,
          };
        }
        return {
          parts: [tool, '-m', mod],
          consumed: 3,
          allowScoping: false,
          nestedBinary: tool,
        };
      }
      const multiModSpec = SCOPEABLE_PYTHON_MULTI_MODULES.get(mod);
      if (multiModSpec !== undefined) {
        if (sub !== undefined && multiModSpec.scopeableSubcommands.has(sub)) {
          return {
            parts: [tool, '-m', mod, sub],
            consumed: 4,
            allowScoping: true,
            nestedBinary: tool,
          };
        }
        if (multiModSpec.allowBareScoping && !isSubcommandToken(sub)) {
          return {
            parts: [tool, '-m', mod],
            consumed: 3,
            allowScoping: true,
            nestedBinary: tool,
          };
        }
        if (isSubcommandToken(sub)) {
          return {
            parts: [tool, '-m', mod, sub],
            consumed: 4,
            allowScoping: false,
            nestedBinary: tool,
          };
        }
        return {
          parts: [tool, '-m', mod],
          consumed: 3,
          allowScoping: false,
          nestedBinary: tool,
        };
      }
      if (SCOPEABLE_PYTHON_SINGLE_MODULES.has(mod)) {
        return {
          parts: [tool, '-m', mod],
          consumed: 3,
          allowScoping: true,
          nestedBinary: tool,
        };
      }
      return {
        parts: [tool, '-m', mod],
        consumed: 3,
        allowScoping: false,
        nestedBinary: tool,
      };
    }
    if (next !== undefined) {
      return {
        parts: [tool, next],
        consumed: 2,
        allowScoping: false,
        nestedBinary: tool,
      };
    }
    return { parts: [tool], consumed: 1, allowScoping: false, nestedBinary: tool };
  }

  if (isNodeBinary(tool) && tokens[startIndex + 1] === '--test') {
    return {
      parts: [tool, '--test'],
      consumed: 2,
      allowScoping: true,
      nestedBinary: tool,
    };
  }

  if (isInterpreterBinary(tool)) {
    const next = tokens[startIndex + 1];
    if (next !== undefined) {
      return {
        parts: [tool, next],
        consumed: 2,
        allowScoping: false,
        nestedBinary: tool,
      };
    }
    return { parts: [tool], consumed: 1, allowScoping: false, nestedBinary: tool };
  }

  if (EXACT_MATCH_ONLY_TOOLS.has(toolBase)) {
    const next = tokens[startIndex + 1];
    if (next !== undefined) {
      return {
        parts: [tool, next],
        consumed: 2,
        allowScoping: false,
        nestedBinary: tool,
      };
    }
    return { parts: [tool], consumed: 1, allowScoping: false, nestedBinary: tool };
  }

  const multiSpec = SCOPEABLE_MULTI_TOOLS.get(toolBase);
  if (multiSpec !== undefined) {
    const sub = tokens[startIndex + 1];
    if (sub !== undefined && multiSpec.scopeableSubcommands.has(sub)) {
      return {
        parts: [tool, sub],
        consumed: 2,
        allowScoping: true,
        nestedBinary: tool,
      };
    }
    if (
      sub !== undefined &&
      multiSpec.nonScopeableSubcommands !== undefined &&
      multiSpec.nonScopeableSubcommands.has(sub)
    ) {
      return {
        parts: [tool, sub],
        consumed: 2,
        allowScoping: false,
        nestedBinary: tool,
      };
    }
    if (multiSpec.allowBareScoping) {
      if (
        sub !== undefined &&
        isSubcommandToken(sub) &&
        multiSpec.nonScopeableSubcommands === undefined
      ) {
        return {
          parts: [tool, sub],
          consumed: 2,
          allowScoping: false,
          nestedBinary: tool,
        };
      }
      return {
        parts: [tool],
        consumed: 1,
        allowScoping: true,
        nestedBinary: tool,
      };
    }
    if (isSubcommandToken(sub)) {
      return {
        parts: [tool, sub],
        consumed: 2,
        allowScoping: false,
        nestedBinary: tool,
      };
    }
    return {
      parts: [tool],
      consumed: 1,
      allowScoping: false,
      nestedBinary: tool,
    };
  }

  if (SCOPEABLE_SINGLE_TOOLS.has(toolBase)) {
    return { parts: [tool], consumed: 1, allowScoping: true, nestedBinary: tool };
  }

  // Default-deny scoping for unknown/unmodeled tools: exact match only.
  return { parts: [tool], consumed: 1, allowScoping: false, nestedBinary: tool };
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
        const thirdBase = posixPath.basename(third.replace(/\\/g, '/'));
        const allowScoping =
          !isPythonBinary(third) &&
          !isInterpreterBinary(third) &&
          !EXACT_MATCH_ONLY_TOOLS.has(thirdBase) &&
          !hasBinaryPathQualifier(third);
        return {
          signature: ['npm', 'run', third],
          consumed: 3,
          allowScoping,
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
        nestedBinary: nested.nestedBinary,
      };
    }
    if (second !== undefined && !second.startsWith('-')) {
      return { signature: ['npm', second], consumed: 2, allowScoping: false };
    }
    return { signature: ['npm'], consumed: 1, allowScoping: false };
  }

  if (first === 'pnpm' || first === 'yarn') {
    const second = tokens[1];
    const third = tokens[2];
    if (second === 'run') {
      if (third !== undefined && !third.startsWith('-')) {
        const thirdBase = posixPath.basename(third.replace(/\\/g, '/'));
        const allowScoping =
          !isPythonBinary(third) &&
          !isInterpreterBinary(third) &&
          !EXACT_MATCH_ONLY_TOOLS.has(thirdBase) &&
          !PACKAGE_MANAGER_EXACT_SUBCOMMANDS.has(third) &&
          !hasBinaryPathQualifier(third);
        return { signature: [first, third], consumed: 3, allowScoping };
      }
      return { signature: [first, 'run'], consumed: 2, allowScoping: false };
    }
    if (second === 'exec') {
      let idx = 2;
      if (tokens[idx] === '--') {
        idx += 1;
      }
      const nested = parseToolSignature(tokens, idx);
      return {
        signature: [first, 'exec', ...nested.parts],
        consumed: idx + nested.consumed,
        allowScoping: nested.allowScoping,
        nestedBinary: nested.nestedBinary,
      };
    }
    if (second !== undefined && !second.startsWith('-')) {
      if (PACKAGE_MANAGER_EXACT_SUBCOMMANDS.has(second)) {
        return { signature: [first, second], consumed: 2, allowScoping: false };
      }
      if (PACKAGE_MANAGER_SCOPEABLE_SCRIPTS.has(second)) {
        return { signature: [first, second], consumed: 2, allowScoping: true };
      }
      const nested = parseToolSignature(tokens, 1);
      return {
        signature: [first, ...nested.parts],
        consumed: 1 + nested.consumed,
        allowScoping: nested.allowScoping,
        nestedBinary: nested.nestedBinary,
      };
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
      nestedBinary: nested.nestedBinary,
    };
  }

  if (first === 'uv' || first === 'poetry' || first === 'pdm') {
    const second = tokens[1];
    if (second === 'run') {
      const leading =
        first === 'uv'
          ? parseUvRunLeadingFlags(tokens, 2)
          : { runnerFlags: [], nextIndex: 2 };
      const nested = parseToolSignature(tokens, leading.nextIndex);
      if (nested.parts.length === 0) {
        return {
          signature: [first, 'run'],
          consumed: leading.nextIndex,
          allowScoping: false,
          runnerFlags: leading.runnerFlags,
        };
      }
      return {
        signature: [first, 'run', ...nested.parts],
        consumed: leading.nextIndex + nested.consumed,
        allowScoping: nested.allowScoping,
        runnerFlags: leading.runnerFlags,
        nestedBinary: nested.nestedBinary,
      };
    }
    if (isSubcommandToken(second)) {
      return { signature: [first, second], consumed: 2, allowScoping: false };
    }
    return { signature: [first], consumed: 1, allowScoping: false };
  }

  if (first === 'bun') {
    const second = tokens[1];
    const third = tokens[2];
    if (second === 'run' && third !== undefined && !third.startsWith('-')) {
      const thirdBase = posixPath.basename(third.replace(/\\/g, '/'));
      const allowScoping =
        !isPythonBinary(third) &&
        !isInterpreterBinary(third) &&
        !EXACT_MATCH_ONLY_TOOLS.has(thirdBase) &&
        !PACKAGE_MANAGER_EXACT_SUBCOMMANDS.has(third) &&
        !third.includes('/') &&
        !third.includes('\\') &&
        !third.includes('.');
      return {
        signature: ['bun', 'run', third],
        consumed: 3,
        allowScoping,
      };
    }
    if (second === 'x') {
      const nested = parseToolSignature(tokens, 2);
      return {
        signature: ['bun', 'x', ...nested.parts],
        consumed: 2 + nested.consumed,
        allowScoping: nested.allowScoping,
        nestedBinary: nested.nestedBinary,
      };
    }
    if (second === 'test') {
      return { signature: ['bun', 'test'], consumed: 2, allowScoping: true };
    }
    if (second !== undefined && !second.startsWith('-')) {
      if (PACKAGE_MANAGER_EXACT_SUBCOMMANDS.has(second)) {
        return { signature: ['bun', second], consumed: 2, allowScoping: false };
      }
      const nested = parseToolSignature(tokens, 1);
      return {
        signature: ['bun', ...nested.parts],
        consumed: 1 + nested.consumed,
        allowScoping: nested.allowScoping,
        nestedBinary: nested.nestedBinary,
      };
    }
    return { signature: ['bun'], consumed: 1, allowScoping: false };
  }

  const parsed = parseToolSignature(tokens, 0);
  return {
    signature: parsed.parts,
    consumed: parsed.consumed,
    allowScoping: parsed.allowScoping,
    nestedBinary: parsed.nestedBinary,
  };
}

export function extractCommandSignature(tokens: readonly string[]): string[] {
  return parseCommandSignature(tokens).signature;
}

export function hasPathTraversal(value: string): boolean {
  if (value === '..') {
    return true;
  }
  const segments = value.split(/[/\\:,=\s;]/);
  return segments.includes('..');
}

function isAbsoluteOrHomePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('~') ||
    WINDOWS_DRIVE_RE.test(value)
  );
}

function isPathInsideDir(parentDir: string, targetPath: string): boolean {
  const rel = relative(parentDir, targetPath);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

function stripScopedTargetSuffixes(arg: string): string {
  let fsTarget = arg;
  const nodeIdIdx = fsTarget.indexOf('::');
  if (nodeIdIdx !== -1) {
    fsTarget = fsTarget.slice(0, nodeIdIdx);
  }
  if (fsTarget === '...' || fsTarget === './...') {
    fsTarget = '.';
  } else if (fsTarget.endsWith('/...')) {
    fsTarget = fsTarget.slice(0, -4);
  }
  fsTarget = fsTarget.replace(/:\d+(?::\d+)?$/, '');
  return fsTarget;
}

function validateSafeRepoRelativePath(value: string): string | null {
  if (value.length === 0) {
    return 'Empty path argument is not allowed';
  }
  if (value.startsWith('@')) {
    return `Argfile or scoped package positional "${value}" is not allowed unless verbatim in CI workflow command`;
  }
  if (hasPathTraversal(value)) {
    return `Path traversal ("..") is not allowed in argument "${value}"`;
  }
  if (isAbsoluteOrHomePath(value)) {
    return `Absolute or home path "${value}" is not allowed outside repository`;
  }
  if (URL_SCHEME_RE.test(value)) {
    return `URL or package specifier "${value}" is not allowed`;
  }
  if (REMOTE_HOST_PATH_RE.test(value)) {
    return `Remote package or host path "${value}" is not allowed`;
  }
  if (value.includes('::')) {
    for (const part of value.split('::')) {
      if (isAbsoluteOrHomePath(part) || URL_SCHEME_RE.test(part)) {
        return `External path "${value}" is not allowed outside repository`;
      }
    }
  }
  const pathPart = value.includes('::')
    ? value.slice(0, value.indexOf('::'))
    : value;
  if (pathPart.includes('@')) {
    return `Package version specifier "${value}" is not allowed`;
  }
  if (ENV_ASSIGNMENT_RE.test(value)) {
    return `Inline environment assignment "${value}" is not allowed`;
  }
  if (value.includes('\\')) {
    return `Backslash path "${value}" is not allowed`;
  }
  if (
    !value.includes('/') &&
    !value.includes('.') &&
    DISALLOWED_BARE_ACTION_WORDS.has(value.toLowerCase())
  ) {
    return `Disallowed action positional "${value}" (not present verbatim in CI workflow command)`;
  }
  return null;
}

function validateScopedPositionalOnDisk(
  arg: string,
  pathContext: ScopedPathContext,
): string | null {
  const fsTarget = stripScopedTargetSuffixes(arg);
  if (fsTarget.length === 0) {
    return `Invalid empty scoped target "${arg}"`;
  }

  const candidatePath = resolve(pathContext.effectiveCwd, fsTarget);
  if (!isPathInsideDir(pathContext.effectiveCwd, candidatePath)) {
    return `Scoped target "${arg}" escapes working directory`;
  }

  let realTarget: string;
  try {
    realTarget = realpathSync(candidatePath);
  } catch {
    return `Scoped target "${arg}" does not exist inside repository`;
  }

  if (
    !isPathInsideDir(pathContext.realEffectiveCwd, realTarget) ||
    !isPathInsideDir(pathContext.realRepoRoot, realTarget)
  ) {
    return `Scoped target "${arg}" resolves outside repository root`;
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

function parseCdTarget(
  tokens: readonly string[],
): { ok: true; dir: string } | { ok: false } {
  if (tokens[0] !== 'cd') {
    return { ok: false };
  }
  let target: string | undefined;
  if (tokens.length === 2) {
    target = tokens[1];
  } else if (tokens.length === 3 && tokens[1] === '--') {
    target = tokens[2];
  } else {
    return { ok: false };
  }

  if (
    target === undefined ||
    target.length === 0 ||
    target === '-' ||
    target.startsWith('-') ||
    hasPathTraversal(target) ||
    isAbsoluteOrHomePath(target) ||
    URL_SCHEME_RE.test(target) ||
    target.includes('\\')
  ) {
    return { ok: false };
  }

  return { ok: true, dir: target };
}

function combineRelativeWorkingDirectory(
  currentDir: string | undefined,
  nextDir: string,
): string | null {
  if (
    hasPathTraversal(nextDir) ||
    isAbsoluteOrHomePath(nextDir) ||
    URL_SCHEME_RE.test(nextDir) ||
    nextDir.includes('\\')
  ) {
    return null;
  }

  if (currentDir !== undefined && currentDir.trim().length > 0) {
    if (
      hasPathTraversal(currentDir) ||
      isAbsoluteOrHomePath(currentDir) ||
      URL_SCHEME_RE.test(currentDir) ||
      currentDir.includes('\\')
    ) {
      return null;
    }
    const joined = posixPath.normalize(posixPath.join(currentDir, nextDir));
    if (
      joined === '..' ||
      joined.startsWith('../') ||
      isAbsoluteOrHomePath(joined)
    ) {
      return null;
    }
    return joined;
  }

  const normalized = posixPath.normalize(nextDir);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    isAbsoluteOrHomePath(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseWorkflowBaselines(
  workflowCommands: readonly VerifyWorkflowCommand[],
): ParsedBaseline[] {
  const baselines: ParsedBaseline[] = [];

  for (const wf of workflowCommands) {
    const segments = splitBaselineSegments(wf.command);
    let currentWorkingDir: string | undefined = wf.workingDirectory;

    for (const segment of segments) {
      const tokenized = tokenizeCommand(segment);
      if (!tokenized.ok) {
        if (/(?:^|\s)(?:cd|pushd|popd)(?:\s|$)/.test(segment)) {
          break;
        }
        continue;
      }
      const envFree = stripLeadingEnvTokens(tokenized.tokens);
      const head = envFree[0];
      if (head === undefined) {
        continue;
      }

      if (head === 'cd') {
        const cdParsed = parseCdTarget(envFree);
        if (!cdParsed.ok) {
          break;
        }
        const combined = combineRelativeWorkingDirectory(
          currentWorkingDir,
          cdParsed.dir,
        );
        if (combined === null) {
          break;
        }
        currentWorkingDir = combined === '.' ? undefined : combined;
        continue;
      }

      if (head === 'pushd' || head === 'popd') {
        break;
      }

      if (SHELL_BUILTINS.has(head)) {
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
        runnerFlags: parsed.runnerFlags ?? [],
      };
      if (parsed.nestedBinary !== undefined) {
        baseline.nestedBinary = parsed.nestedBinary;
      }
      if (currentWorkingDir !== undefined) {
        baseline.workingDirectory = currentWorkingDir;
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

function isPytestToolToken(token: string | undefined): boolean {
  if (token === undefined) {
    return false;
  }
  const base = posixPath.basename(token.replace(/\\/g, '/'));
  return base === 'pytest' || base === 'py.test';
}

function isPytestSignature(signature: readonly string[]): boolean {
  if (signature.length === 1 && isPytestToolToken(signature[0])) {
    return true;
  }
  if (
    signature.length === 3 &&
    signature[0] !== undefined &&
    isPythonBinary(signature[0]) &&
    signature[1] === '-m' &&
    signature[2] === 'pytest'
  ) {
    return true;
  }
  if (
    (signature[0] === 'uv' ||
      signature[0] === 'poetry' ||
      signature[0] === 'pdm') &&
    signature[1] === 'run'
  ) {
    return isPytestSignature(signature.slice(2));
  }
  return false;
}

function isToolAllowedPatternValueFlag(
  flagName: string,
  signature: readonly string[],
): boolean {
  return (
    SAFE_PATTERN_VALUE_FLAGS.has(flagName) ||
    (PYTEST_ONLY_PATTERN_VALUE_FLAGS.has(flagName) &&
      isPytestSignature(signature))
  );
}

function validateFlagValue(
  flagName: string,
  value: string,
  signature: readonly string[],
): string | null {
  if (value.length === 0) {
    return `Flag "${flagName}" requires a non-empty value`;
  }
  if (hasPathTraversal(value)) {
    return `Path traversal ("..") is not allowed in value for "${flagName}"`;
  }

  if (isToolAllowedPatternValueFlag(flagName, signature)) {
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

function isSafeValueFlag(
  flagName: string,
  signature: readonly string[],
): boolean {
  return (
    isToolAllowedPatternValueFlag(flagName, signature) ||
    SAFE_PATH_PATTERN_FLAGS.has(flagName) ||
    SAFE_NUMERIC_VALUE_FLAGS.has(flagName) ||
    SAFE_RULE_VALUE_FLAGS.has(flagName) ||
    SAFE_ENUM_VALUE_FLAGS.has(flagName)
  );
}

function validateRunnerFlags(
  candidateRunnerFlags: readonly string[],
  baselineRunnerFlags: readonly string[],
): string | null {
  const baselineBoolSet = new Set<string>();
  const baselineEqSet = new Set<string>();
  const baselinePairSet = new Set<string>();

  for (let i = 0; i < baselineRunnerFlags.length; i += 1) {
    const tok = baselineRunnerFlags[i];
    if (tok === undefined || tok === '--') {
      continue;
    }
    if (tok.includes('=')) {
      baselineEqSet.add(tok);
      continue;
    }
    if (UV_RUN_VALUE_FLAGS.has(tok)) {
      const val = baselineRunnerFlags[i + 1];
      if (val !== undefined) {
        baselinePairSet.add(`${tok}\0${val}`);
        i += 1;
      }
      continue;
    }
    baselineBoolSet.add(tok);
  }

  const seenBoolSet = new Set<string>();
  const seenEqSet = new Set<string>();
  const seenPairSet = new Set<string>();

  for (let i = 0; i < candidateRunnerFlags.length; i += 1) {
    const tok = candidateRunnerFlags[i];
    if (tok === undefined || tok === '--') {
      continue;
    }
    if (tok.includes('=')) {
      if (!baselineEqSet.has(tok)) {
        return `Disallowed runner flag "${tok}" (not present verbatim in CI workflow command)`;
      }
      seenEqSet.add(tok);
      continue;
    }
    if (UV_RUN_VALUE_FLAGS.has(tok)) {
      const val = candidateRunnerFlags[i + 1];
      if (val === undefined || !baselinePairSet.has(`${tok}\0${val}`)) {
        return `Disallowed runner flag "${tok}" value (not present verbatim in CI workflow command)`;
      }
      seenPairSet.add(`${tok}\0${val}`);
      i += 1;
      continue;
    }
    if (baselineBoolSet.has(tok)) {
      seenBoolSet.add(tok);
      continue;
    }
    if (UV_RUN_SAFE_EXTRA_BOOL_FLAGS.has(tok)) {
      continue;
    }
    return `Disallowed runner flag "${tok}" (not present in CI workflow command)`;
  }

  for (const reqFlag of baselineBoolSet) {
    if (!seenBoolSet.has(reqFlag)) {
      return `Candidate command dropped required CI baseline runner flag "${reqFlag}"`;
    }
  }
  for (const reqEq of baselineEqSet) {
    if (!seenEqSet.has(reqEq)) {
      return `Candidate command dropped required CI baseline runner flag "${reqEq}"`;
    }
  }
  for (const reqPair of baselinePairSet) {
    if (!seenPairSet.has(reqPair)) {
      const [flagName, flagVal] = reqPair.split('\0');
      return `Candidate command dropped required CI baseline runner flag "${flagName ?? ''} ${flagVal ?? ''}"`;
    }
  }

  return null;
}

interface BaselineFlagEntry {
  flag: string;
  afterDoubleDash: boolean;
}

interface BaselinePairEntry {
  flag: string;
  value: string;
  afterDoubleDash: boolean;
}

function scopedFlagKey(afterDoubleDash: boolean, flag: string): string {
  return `${afterDoubleDash ? '1' : '0'}\0${flag}`;
}

function scopedPairKey(
  afterDoubleDash: boolean,
  flag: string,
  value: string,
): string {
  return `${afterDoubleDash ? '1' : '0'}\0${flag}\0${value}`;
}

function formatRequiredFlagPositionNote(
  afterDoubleDash: boolean,
  candidateSawDoubleDash: boolean,
): string {
  if (afterDoubleDash) {
    return ' (must appear after "--")';
  }
  if (candidateSawDoubleDash) {
    return ' (must appear before "--")';
  }
  return '';
}

function validateScopedArguments(
  candidateExtraArgs: readonly string[],
  baselineExtraArgs: readonly string[],
  signature: readonly string[],
  pathContext: ScopedPathContext | null,
): string | null {
  const baselineStandaloneFlags = new Map<string, BaselineFlagEntry>();
  const baselineDangerousStandaloneFlags = new Map<string, BaselineFlagEntry>();
  const baselineEqFlags = new Map<string, BaselineFlagEntry>();
  const baselinePositionals = new Set<string>();
  const baselinePairs = new Map<string, BaselinePairEntry>();

  let baselineAfterDoubleDash = false;
  for (let i = 0; i < baselineExtraArgs.length; i += 1) {
    const tok = baselineExtraArgs[i];
    if (tok === undefined) {
      continue;
    }
    if (tok === '--') {
      baselineAfterDoubleDash = true;
      continue;
    }
    if (tok.startsWith('-')) {
      if (tok.includes('=')) {
        baselineEqFlags.set(scopedFlagKey(baselineAfterDoubleDash, tok), {
          flag: tok,
          afterDoubleDash: baselineAfterDoubleDash,
        });
        continue;
      }
      const next = baselineExtraArgs[i + 1];
      const isKnownBooleanOnly =
        SAFE_STANDALONE_FLAGS.has(tok) &&
        (!isSafeValueFlag(tok, signature) ||
          next === undefined ||
          next.startsWith('-') ||
          validateFlagValue(tok, next, signature) !== null);
      if (isKnownBooleanOnly) {
        baselineStandaloneFlags.set(
          scopedFlagKey(baselineAfterDoubleDash, tok),
          {
            flag: tok,
            afterDoubleDash: baselineAfterDoubleDash,
          },
        );
        continue;
      }
      if (next !== undefined && !next.startsWith('-')) {
        baselinePairs.set(scopedPairKey(baselineAfterDoubleDash, tok, next), {
          flag: tok,
          value: next,
          afterDoubleDash: baselineAfterDoubleDash,
        });
        i += 1;
        continue;
      }
      if (DANGEROUS_FLAGS.has(tok)) {
        baselineDangerousStandaloneFlags.set(
          scopedFlagKey(baselineAfterDoubleDash, tok),
          {
            flag: tok,
            afterDoubleDash: baselineAfterDoubleDash,
          },
        );
      } else {
        baselineStandaloneFlags.set(
          scopedFlagKey(baselineAfterDoubleDash, tok),
          {
            flag: tok,
            afterDoubleDash: baselineAfterDoubleDash,
          },
        );
      }
      continue;
    }
    baselinePositionals.add(tok);
  }

  const seenStandaloneFlags = new Set<string>();
  const seenEqFlags = new Set<string>();
  const seenPairs = new Set<string>();

  let candidateAfterDoubleDash = false;
  for (let i = 0; i < candidateExtraArgs.length; i += 1) {
    const arg = candidateExtraArgs[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.length === 0) {
      return 'Empty argument is not allowed';
    }
    if (arg === '--') {
      candidateAfterDoubleDash = true;
      continue;
    }

    if (arg.startsWith('-')) {
      const next = candidateExtraArgs[i + 1];
      if (next !== undefined && next !== '--') {
        const pairKey = scopedPairKey(candidateAfterDoubleDash, arg, next);
        if (baselinePairs.has(pairKey)) {
          seenPairs.add(pairKey);
          i += 1;
          continue;
        }
      }

      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const flagName = arg.slice(0, eqIdx);
        const flagVal = arg.slice(eqIdx + 1);
        const eqKey = scopedFlagKey(candidateAfterDoubleDash, arg);
        if (baselineEqFlags.has(eqKey)) {
          seenEqFlags.add(eqKey);
          continue;
        }
        if (DANGEROUS_FLAGS.has(flagName)) {
          return `Disallowed dangerous flag "${flagName}" (not present verbatim in CI workflow command)`;
        }
        if (!isSafeValueFlag(flagName, signature)) {
          return `Disallowed flag "${flagName}" (not present in CI workflow command or scoping allowlist)`;
        }
        const valueError = validateFlagValue(flagName, flagVal, signature);
        if (valueError !== null) {
          return valueError;
        }
        continue;
      }

      // Bare flag (no '=')
      const standaloneKey = scopedFlagKey(candidateAfterDoubleDash, arg);
      if (
        baselineStandaloneFlags.has(standaloneKey) &&
        !DANGEROUS_FLAGS.has(arg)
      ) {
        seenStandaloneFlags.add(standaloneKey);
        continue;
      }
      if (DANGEROUS_FLAGS.has(arg)) {
        return `Disallowed dangerous flag "${arg}" (not present verbatim in CI workflow command)`;
      }

      if (SAFE_STANDALONE_FLAGS.has(arg)) {
        // Handle flags that can be either boolean or value-taking (e.g. --bail, --pretty, --color)
        if (
          isSafeValueFlag(arg, signature) &&
          next !== undefined &&
          !next.startsWith('-') &&
          validateFlagValue(arg, next, signature) === null
        ) {
          i += 1;
        }
        continue;
      }

      if (isSafeValueFlag(arg, signature)) {
        if (next === undefined || next.startsWith('-')) {
          return `Flag "${arg}" requires a value`;
        }
        const valueError = validateFlagValue(arg, next, signature);
        if (valueError !== null) {
          return valueError;
        }
        i += 1;
        continue;
      }

      return `Disallowed flag "${arg}" (not present in CI workflow command or scoping allowlist)`;
    }

    // Positional argument: allow if verbatim in baseline (still checked for path traversal globally)
    // or if it is a safe repo-relative path / test target (and exists within cwd when cwd exists).
    if (baselinePositionals.has(arg)) {
      continue;
    }

    const pathError = validateSafeRepoRelativePath(arg);
    if (pathError !== null) {
      return pathError;
    }

    if (pathContext !== null) {
      const diskError = validateScopedPositionalOnDisk(arg, pathContext);
      if (diskError !== null) {
        return diskError;
      }
    }
  }

  for (const [key, entry] of baselineStandaloneFlags) {
    if (!seenStandaloneFlags.has(key)) {
      const positionNote = formatRequiredFlagPositionNote(
        entry.afterDoubleDash,
        candidateAfterDoubleDash,
      );
      return `Candidate command dropped required CI baseline flag "${entry.flag}"${positionNote}`;
    }
  }
  for (const entry of baselineDangerousStandaloneFlags.values()) {
    const positionNote = formatRequiredFlagPositionNote(
      entry.afterDoubleDash,
      candidateAfterDoubleDash,
    );
    return `Candidate command dropped required CI baseline flag "${entry.flag}"${positionNote}`;
  }
  for (const [key, entry] of baselineEqFlags) {
    if (!seenEqFlags.has(key)) {
      const positionNote = formatRequiredFlagPositionNote(
        entry.afterDoubleDash,
        candidateAfterDoubleDash,
      );
      return `Candidate command dropped required CI baseline flag "${entry.flag}"${positionNote}`;
    }
  }
  for (const [key, entry] of baselinePairs) {
    if (!seenPairs.has(key)) {
      const positionNote = formatRequiredFlagPositionNote(
        entry.afterDoubleDash,
        candidateAfterDoubleDash,
      );
      return `Candidate command dropped required CI baseline flag "${entry.flag} ${entry.value}"${positionNote}`;
    }
  }

  return null;
}

function resolveCwdContext(options?: CheckAllowlistOptions): ResolvedCwdContext | null {
  const rawCwd = options?.cwd;
  if (rawCwd === undefined || rawCwd.trim().length === 0) {
    return null;
  }
  const repoRoot = resolve(rawCwd);
  if (!existsSync(repoRoot)) {
    return null;
  }
  try {
    const realRepoRoot = realpathSync(repoRoot);
    if (!statSync(realRepoRoot).isDirectory()) {
      return null;
    }
    return { repoRoot, realRepoRoot };
  } catch {
    return null;
  }
}

function resolveBaselinePathContext(
  cwdContext: ResolvedCwdContext | null,
  workingDirectory: string | undefined,
):
  | { ok: true; pathContext: ScopedPathContext | null }
  | { ok: false; reason: string } {
  if (
    workingDirectory !== undefined &&
    (hasPathTraversal(workingDirectory) ||
      isAbsoluteOrHomePath(workingDirectory) ||
      URL_SCHEME_RE.test(workingDirectory) ||
      workingDirectory.includes('\\'))
  ) {
    return {
      ok: false,
      reason: `Unsafe workflow workingDirectory "${workingDirectory}"`,
    };
  }

  if (cwdContext === null) {
    return { ok: true, pathContext: null };
  }

  if (workingDirectory === undefined || workingDirectory.trim().length === 0) {
    return {
      ok: true,
      pathContext: {
        effectiveCwd: cwdContext.repoRoot,
        realEffectiveCwd: cwdContext.realRepoRoot,
        realRepoRoot: cwdContext.realRepoRoot,
      },
    };
  }

  const effectiveCwd = resolve(cwdContext.repoRoot, workingDirectory);
  if (!isPathInsideDir(cwdContext.repoRoot, effectiveCwd)) {
    return {
      ok: false,
      reason: `Unsafe workflow workingDirectory "${workingDirectory}": escapes repository root`,
    };
  }

  let realEffectiveCwd: string;
  try {
    realEffectiveCwd = realpathSync(effectiveCwd);
    if (!statSync(realEffectiveCwd).isDirectory()) {
      return {
        ok: false,
        reason: `Unsafe workflow workingDirectory "${workingDirectory}": target is not a directory`,
      };
    }
  } catch {
    return {
      ok: false,
      reason: `Unsafe workflow workingDirectory "${workingDirectory}": directory does not exist inside repository`,
    };
  }

  if (!isPathInsideDir(cwdContext.realRepoRoot, realEffectiveCwd)) {
    return {
      ok: false,
      reason: `Unsafe workflow workingDirectory "${workingDirectory}": symlink resolves outside repository root`,
    };
  }

  return {
    ok: true,
    pathContext: {
      effectiveCwd,
      realEffectiveCwd,
      realRepoRoot: cwdContext.realRepoRoot,
    },
  };
}

function buildAllowedDecision(
  candidateTokens: readonly string[],
  baseline: ParsedBaseline,
  cwdContext: ResolvedCwdContext | null,
): AllowlistDecision {
  const binary = candidateTokens[0];
  if (binary === undefined) {
    return { allowed: false, reason: 'Command is empty' };
  }

  const pathCheck = resolveBaselinePathContext(
    cwdContext,
    baseline.workingDirectory,
  );
  if (!pathCheck.ok) {
    return { allowed: false, reason: pathCheck.reason };
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
  options?: CheckAllowlistOptions,
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

  if (SHELL_BUILTINS.has(binary)) {
    return {
      allowed: false,
      reason: `Disallowed shell builtin "${binary}" in command`,
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

  const cwdContext = resolveCwdContext(options);

  if (
    hasBinaryPathQualifier(binary) &&
    !baselines.some((baseline) => baseline.tokens[0] === binary)
  ) {
    return {
      allowed: false,
      reason: `Path-qualified binary "${binary}" is not present verbatim in any CI workflow command`,
    };
  }

  // 1. Exact token match against any env-free baseline workflow command
  for (const baseline of baselines) {
    if (arraysEqual(candidateTokens, baseline.tokens)) {
      return buildAllowedDecision(candidateTokens, baseline, cwdContext);
    }
  }

  // 2. Same normalized tool + subcommand signature with safe scoping arguments
  const candidateParsed = parseCommandSignature(candidateTokens);
  if (
    candidateParsed.nestedBinary !== undefined &&
    hasBinaryPathQualifier(candidateParsed.nestedBinary) &&
    !baselines.some(
      (baseline) => baseline.nestedBinary === candidateParsed.nestedBinary,
    )
  ) {
    return {
      allowed: false,
      reason: `Path-qualified binary "${candidateParsed.nestedBinary}" is not present verbatim in any CI workflow command`,
    };
  }

  if (!candidateParsed.allowScoping) {
    return {
      allowed: false,
      reason: `Command "${candidateParsed.signature.join(' ')}" requires an exact match to a CI workflow command`,
    };
  }

  const candidateRunnerFlags = candidateParsed.runnerFlags ?? [];
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
    if (hasBinaryPathQualifier(binary) && baseline.tokens[0] !== binary) {
      continue;
    }
    if (
      candidateParsed.nestedBinary !== undefined &&
      hasBinaryPathQualifier(candidateParsed.nestedBinary) &&
      baseline.nestedBinary !== candidateParsed.nestedBinary
    ) {
      continue;
    }
    matchedAnySignature = true;

    const runnerFlagError = validateRunnerFlags(
      candidateRunnerFlags,
      baseline.runnerFlags,
    );
    if (runnerFlagError !== null) {
      if (firstValidationError === null) {
        firstValidationError = runnerFlagError;
      }
      continue;
    }

    const baselinePathCheck = resolveBaselinePathContext(
      cwdContext,
      baseline.workingDirectory,
    );
    if (!baselinePathCheck.ok) {
      if (firstValidationError === null) {
        firstValidationError = baselinePathCheck.reason;
      }
      continue;
    }

    const baselineExtraArgs = baseline.tokens.slice(baseline.consumed);
    const validationError = validateScopedArguments(
      candidateExtraArgs,
      baselineExtraArgs,
      baseline.signature,
      baselinePathCheck.pathContext,
    );
    if (validationError === null) {
      return buildAllowedDecision(candidateTokens, baseline, cwdContext);
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
