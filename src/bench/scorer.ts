import { posix as posixPath } from 'node:path';
import { DEFAULT_MAX_INPUT_TOKENS } from '../gather/budget.js';
import type { ThinkOutput } from '../think/index.js';
import {
  checkCommandAllowlist,
  extractCommandSignature,
  tokenizeCommand,
  type VerifyWorkflowCommand,
} from '../verify/index.js';
import type {
  BenchCase,
  BenchCaseContext,
  BenchCaseResult,
  BenchCaseScore,
  BenchRefusedCommand,
  BenchSummaryMetrics,
} from './types.js';

interface BaselineCommandSpec {
  job: string;
  command: string;
}

const REPO_BASELINE_COMMANDS: Readonly<Record<string, readonly BaselineCommandSpec[]>> = {
  'expressjs/express': [
    { job: 'test', command: 'npm run test-ci' },
    { job: 'test', command: 'npm test' },
    { job: 'lint', command: 'npm run lint' },
  ],
  'colinhacks/zod': [
    { job: 'test', command: 'nub run test' },
    { job: 'lint', command: 'pnpm format:check' },
    { job: 'test', command: 'pnpm test' },
  ],
  'unjs/h3': [
    { job: 'test', command: 'pnpm vitest --coverage' },
    { job: 'lint', command: 'pnpm lint' },
  ],
  'fastify/fastify': [
    { job: 'test', command: 'npm test' },
    { job: 'lint', command: 'npm run lint' },
  ],
  'axios/axios': [
    { job: 'test', command: 'npm test' },
    { job: 'lint', command: 'npm run lint' },
  ],
  'pallets/werkzeug': [
    { job: 'test', command: 'uv run --locked --no-default-groups --group dev tox run' },
    {
      job: 'typing',
      command: 'uv run --locked --no-default-groups --group dev tox run -e typing',
    },
    { job: 'test', command: 'pytest' },
  ],
  'pallets/jinja': [
    { job: 'test', command: 'uv run --locked tox run' },
    { job: 'typing', command: 'uv run --locked tox run -e typing' },
    { job: 'test', command: 'pytest' },
  ],
  'pallets/click': [
    { job: 'test', command: 'uv run --locked --no-default-groups --group dev tox run' },
    {
      job: 'typing',
      command: 'uv run --locked --no-default-groups --group dev tox run -e typing',
    },
    { job: 'test', command: 'pytest' },
  ],
  'encode/httpx': [
    { job: 'test', command: 'scripts/test' },
    { job: 'lint', command: 'scripts/check' },
    { job: 'test', command: 'pytest' },
  ],
  'pydantic/pydantic-settings': [
    { job: 'test', command: 'make test' },
    {
      job: 'lint',
      command: 'pre-commit run --show-diff-on-failure --color=always --all-files',
    },
    { job: 'test', command: 'pytest' },
  ],
};

const LANGUAGE_BASELINE_COMMANDS: Readonly<Record<string, readonly BaselineCommandSpec[]>> = {
  typescript: [
    { job: 'test', command: 'npm test' },
    { job: 'typecheck', command: 'npm run typecheck' },
    { job: 'lint', command: 'npm run lint' },
  ],
  javascript: [
    { job: 'test', command: 'npm test' },
    { job: 'lint', command: 'npm run lint' },
  ],
  python: [
    { job: 'test', command: 'pytest' },
    { job: 'lint', command: 'ruff check .' },
    { job: 'typecheck', command: 'mypy' },
  ],
  go: [{ job: 'test', command: 'go test ./...' }],
  rust: [{ job: 'test', command: 'cargo test' }],
};

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const FILE_PATH_IN_LABEL_RE =
  /(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|[A-Za-z0-9._-]+\.(?:[cm]?[jt]sx?|py|pyi|json|ya?ml|toml|md|mdx|rst|ejs|txt|cfg|ini|sh))\b/g;
const TRUNCATION_SUFFIX = '\n...[truncated]';

const UV_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--group',
  '--with',
  '--extra',
  '--python',
  '-p',
  '--directory',
  '--project',
  '--package',
]);

function roundOneDecimal(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function inferNeutralJobName(command: string): string {
  const lower = command.toLowerCase();
  if (
    lower.includes('typing') ||
    lower.includes('mypy') ||
    lower.includes('typecheck') ||
    lower.includes('tsc') ||
    lower.includes('pyright')
  ) {
    return 'typecheck';
  }
  if (
    lower.includes('lint') ||
    lower.includes('format') ||
    lower.includes('ruff') ||
    lower.includes('biome') ||
    lower.includes('eslint') ||
    lower.includes('pre-commit') ||
    lower.includes('scripts/check')
  ) {
    return 'lint';
  }
  return 'test';
}

function buildWorkflowCommandsForCase(benchCase: BenchCase): VerifyWorkflowCommand[] {
  const repoKey = benchCase.repo.toLowerCase();
  const langKey = benchCase.language.toLowerCase();
  const baseSpecs =
    REPO_BASELINE_COMMANDS[repoKey] ??
    LANGUAGE_BASELINE_COMMANDS[langKey] ?? [{ job: 'test', command: 'npm test' }];

  const seen = new Set<string>();
  const commands: VerifyWorkflowCommand[] = [];

  const pushUnique = (job: string, command: string): void => {
    const trimmed = command.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    commands.push({
      file: benchCase.workflow_file,
      job,
      command: trimmed,
    });
  };

  for (const spec of baseSpecs) {
    pushUnique(spec.job, spec.command);
  }

  // Ensure any unlisted repo/custom failing_command is represented in the workflow
  // allowlist without exposing ground-truth status or failing_job labels.
  if (benchCase.status === 'fail' && benchCase.failing_command !== null) {
    const trimmedFailing = benchCase.failing_command.trim();
    if (trimmedFailing.length > 0 && !seen.has(trimmedFailing)) {
      pushUnique(inferNeutralJobName(trimmedFailing), trimmedFailing);
    }
  }

  return commands;
}

/**
 * Builds deterministic, leak-free static triage context strictly from PR metadata,
 * SHAs, changed files, workflow file, and baseline CI workflow commands.
 * Never embeds ground-truth `status`, `id`, `root_cause_label`, `log_excerpt`, or `label_verified`.
 */
export function buildDefaultCaseContext(
  benchCase: BenchCase,
  maxInputTokens: number = DEFAULT_MAX_INPUT_TOKENS,
): BenchCaseContext {
  const workflowCommands = buildWorkflowCommandsForCase(benchCase);

  const safeMaxTokens = Number.isFinite(maxInputTokens)
    ? Math.max(0, Math.floor(maxInputTokens))
    : DEFAULT_MAX_INPUT_TOKENS;
  const maxChars = safeMaxTokens * 4;

  if (maxChars === 0) {
    return {
      budgetedContext: '',
      workflowCommands,
    };
  }

  const changedFileLines =
    benchCase.changed_files.length > 0
      ? benchCase.changed_files.map((file) => `- ${file}`)
      : ['- (none)'];

  const workflowLines = workflowCommands.map(
    (entry) => `- [${entry.job}] (${entry.file}): \`${entry.command}\``,
  );

  const fullContext = [
    '## Pull Request Triage Context',
    `- Repository: ${benchCase.repo}`,
    `- Pull Request: #${benchCase.pr}`,
    `- Language: ${benchCase.language}`,
    `- Base SHA: ${benchCase.base_sha}`,
    `- Head SHA: ${benchCase.head_sha}`,
    `- Workflow File: ${benchCase.workflow_file}`,
    '',
    `## Changed Files (${benchCase.changed_files.length})`,
    ...changedFileLines,
    '',
    '## CI Workflow Commands',
    ...workflowLines,
  ].join('\n');

  let budgetedContext = fullContext;
  if (budgetedContext.length > maxChars) {
    if (maxChars <= TRUNCATION_SUFFIX.length) {
      budgetedContext = budgetedContext.slice(0, maxChars);
    } else {
      budgetedContext = `${budgetedContext.slice(0, maxChars - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
    }
  }

  return {
    budgetedContext,
    workflowCommands,
  };
}

function stripLeadingEnvTokens(tokens: readonly string[]): string[] {
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (token === undefined || !ENV_ASSIGNMENT_RE.test(token)) {
      break;
    }
    idx += 1;
  }
  return tokens.slice(idx);
}

function unwrapRunnerTokens(tokens: readonly string[]): string[] {
  const first = tokens[0];
  if (first === undefined) {
    return [];
  }

  if (first === 'npx' || first === 'bunx') {
    let idx = 1;
    while (tokens[idx] === '--no-install' || tokens[idx] === '--no') {
      idx += 1;
    }
    return idx < tokens.length ? tokens.slice(idx) : [...tokens];
  }

  if ((first === 'npm' || first === 'pnpm') && tokens[1] === 'exec') {
    let idx = 2;
    if (tokens[idx] === '--') {
      idx += 1;
    }
    return idx < tokens.length ? tokens.slice(idx) : [...tokens];
  }

  if (
    (first === 'uv' || first === 'poetry' || first === 'pdm') &&
    tokens[1] === 'run'
  ) {
    let idx = 2;
    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (tok === undefined) {
        break;
      }
      if (tok === '--') {
        idx += 1;
        break;
      }
      if (tok.startsWith('-')) {
        if (UV_VALUE_FLAGS.has(tok) && !tok.includes('=')) {
          idx += 2;
        } else {
          idx += 1;
        }
        continue;
      }
      break;
    }
    return idx < tokens.length ? tokens.slice(idx) : [...tokens];
  }

  const base = posixPath.basename(first.replace(/\\/g, '/'));
  if (/^python(3(\.\d+)?)?$/.test(base) && tokens[1] === '-m' && tokens[2] !== undefined) {
    return tokens.slice(2);
  }

  return [...tokens];
}

function extractToxEnv(tokens: readonly string[]): string | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) {
      continue;
    }
    if (tok === '-e' || tok === '--env') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        return next;
      }
    } else if (tok.startsWith('-e=')) {
      return tok.slice(3);
    } else if (tok.startsWith('--env=')) {
      return tok.slice(6);
    }
  }
  return null;
}

function normalizeComparisonSignature(tokens: readonly string[]): string[] {
  const unwrapped = unwrapRunnerTokens(tokens);
  const first = unwrapped[0];
  if (first === undefined) {
    return extractCommandSignature(tokens);
  }

  if (first === 'make') {
    const target = unwrapped[1];
    if (target !== undefined && !target.startsWith('-')) {
      return ['make', target];
    }
    return ['make'];
  }

  if (first === 'pre-commit') {
    const sub = unwrapped[1];
    if (sub !== undefined && !sub.startsWith('-')) {
      return ['pre-commit', sub];
    }
    return ['pre-commit'];
  }

  if (first === 'tox') {
    const baseSig = extractCommandSignature(unwrapped);
    const toxEnv = extractToxEnv(unwrapped);
    return toxEnv !== null ? [...baseSig, '-e', toxEnv] : baseSig;
  }

  return extractCommandSignature(unwrapped);
}

function matchesFailingCommand(
  allowedCommand: string,
  benchCase: BenchCase,
): boolean {
  if (benchCase.failing_command === null) {
    return false;
  }
  const failingCommand = benchCase.failing_command.trim();
  if (failingCommand.length === 0) {
    return false;
  }

  const allowedTok = tokenizeCommand(allowedCommand);
  const failingTok = tokenizeCommand(failingCommand);
  if (!allowedTok.ok || !failingTok.ok) {
    return false;
  }

  const allowedTokens = stripLeadingEnvTokens(allowedTok.tokens);
  const failingTokens = stripLeadingEnvTokens(failingTok.tokens);
  if (allowedTokens.length === 0 || failingTokens.length === 0) {
    return false;
  }

  if (arraysEqual(allowedTokens, failingTokens)) {
    return true;
  }

  const allowedSig = normalizeComparisonSignature(allowedTokens);
  const failingSig = normalizeComparisonSignature(failingTokens);
  if (
    allowedSig.length > 0 &&
    failingSig.length > 0 &&
    arraysEqual(allowedSig, failingSig)
  ) {
    return true;
  }

  const failingBaseline: VerifyWorkflowCommand[] = [
    {
      file: benchCase.workflow_file,
      job: benchCase.failing_job ?? 'ci',
      command: failingCommand,
    },
  ];
  const decision = checkCommandAllowlist(allowedCommand, failingBaseline);
  if (!decision.allowed) {
    return false;
  }

  // Prevent positional scoping on `make` from falsely matching unrelated targets (e.g. `make lint` vs `make test`).
  if (allowedTokens[0] === 'make' && failingTokens[0] === 'make') {
    return arraysEqual(allowedSig, failingSig);
  }

  return true;
}

function normalizePathToken(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/:.*$/, '')
    .toLowerCase();
}

function collectReferenceTargets(benchCase: BenchCase): {
  fullPaths: Set<string>;
  basenames: Set<string>;
} {
  const fullPaths = new Set<string>();
  const basenames = new Set<string>();

  const registerPath = (raw: string): void => {
    const normalized = normalizePathToken(raw);
    if (normalized.length === 0) {
      return;
    }
    fullPaths.add(normalized);
    const base = posixPath.basename(normalized);
    if (base.length >= 2) {
      basenames.add(base);
    }
  };

  for (const changedFile of benchCase.changed_files) {
    registerPath(changedFile);
  }

  const labelMatches = benchCase.root_cause_label.match(FILE_PATH_IN_LABEL_RE);
  if (labelMatches !== null) {
    for (const match of labelMatches) {
      registerPath(match);
    }
  }

  return { fullPaths, basenames };
}

function containsTokenMatch(normalizedText: string, needle: string): boolean {
  const pattern = new RegExp(
    `(?<![a-z0-9_-])${escapeRegExp(needle)}(?![a-z0-9_-]|\\.[a-z0-9_-])`,
  );
  return pattern.test(normalizedText);
}

function textMatchesReference(
  rawText: string | undefined,
  fullPaths: ReadonlySet<string>,
  basenames: ReadonlySet<string>,
): boolean {
  if (rawText === undefined) {
    return false;
  }
  const normalizedText = rawText.trim().replace(/\\/g, '/').toLowerCase();
  if (normalizedText.length === 0) {
    return false;
  }

  const normalizedAsPath = normalizePathToken(rawText);
  if (fullPaths.has(normalizedAsPath) || basenames.has(normalizedAsPath)) {
    return true;
  }

  for (const fullPath of fullPaths) {
    if (containsTokenMatch(normalizedText, fullPath)) {
      return true;
    }
  }

  for (const basename of basenames) {
    if (containsTokenMatch(normalizedText, basename)) {
      return true;
    }
  }

  return false;
}

/**
 * Scores a single Think stage prediction against a benchmark case's workflow
 * allowlist and ground-truth labels.
 */
export function scoreBenchCase(
  benchCase: BenchCase,
  thinkOutput: ThinkOutput,
  workflowCommands: readonly VerifyWorkflowCommand[],
): BenchCaseScore {
  const predictedCommands = [...thinkOutput.commands];
  const allowedCommands: string[] = [];
  const refusedCommands: BenchRefusedCommand[] = [];

  for (const command of predictedCommands) {
    const decision = checkCommandAllowlist(command, workflowCommands);
    if (decision.allowed) {
      allowedCommands.push(command);
    } else {
      refusedCommands.push({ command, reason: decision.reason });
    }
  }

  if (benchCase.status === 'pass') {
    return {
      caught: null,
      commandCaught: null,
      targetCaught: null,
      falseAlarm: thinkOutput.likely_failures.length > 0,
      predictedCommands,
      allowedCommands,
      refusedCommands,
    };
  }

  const commandCaught = allowedCommands.some((cmd) =>
    matchesFailingCommand(cmd, benchCase),
  );

  const { fullPaths, basenames } = collectReferenceTargets(benchCase);
  const targetCaught = thinkOutput.likely_failures.some(
    (failure) =>
      textMatchesReference(failure.target, fullPaths, basenames) ||
      textMatchesReference(failure.file, fullPaths, basenames) ||
      textMatchesReference(failure.reason, fullPaths, basenames),
  );

  return {
    caught: commandCaught || targetCaught,
    commandCaught,
    targetCaught,
    falseAlarm: null,
    predictedCommands,
    allowedCommands,
    refusedCommands,
  };
}

/**
 * Computes exact median (`p = 50`, midpoint average for even length) or
 * nearest-rank percentile (`p` in `[0, 100]`) over finite numbers, rounded to 1 decimal place.
 */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`Percentile p must be between 0 and 100 (got ${p})`);
  }

  const finite = values.filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  if (finite.length === 0) {
    return null;
  }

  const sorted = [...finite].sort((a, b) => a - b);
  const count = sorted.length;

  if (p === 50) {
    if (count % 2 === 1) {
      const mid = sorted[(count - 1) / 2];
      return mid === undefined ? null : roundOneDecimal(mid);
    }
    const lower = sorted[count / 2 - 1];
    const upper = sorted[count / 2];
    if (lower === undefined || upper === undefined) {
      return null;
    }
    return roundOneDecimal((lower + upper) / 2);
  }

  if (p === 0) {
    const first = sorted[0];
    return first === undefined ? null : roundOneDecimal(first);
  }

  const rank = Math.ceil((p * count) / 100);
  const index = Math.min(count - 1, Math.max(0, rank - 1));
  const selected = sorted[index];
  return selected === undefined ? null : roundOneDecimal(selected);
}

/**
 * Aggregates per-case benchmark outcomes and latency/throughput telemetry into summary metrics.
 */
export function aggregateBenchMetrics(
  results: readonly BenchCaseResult[],
): BenchSummaryMetrics {
  let failedCases = 0;
  let passingCases = 0;
  let caught = 0;
  let commandCaught = 0;
  let targetCaught = 0;
  let missed = 0;
  let falseAlarms = 0;
  let allowlistRefusals = 0;
  let errors = 0;

  const wallValues: number[] = [];
  const thinkValues: number[] = [];
  const tokPerSecValues: number[] = [];

  for (const result of results) {
    if (result.status === 'fail') {
      failedCases += 1;
      if (result.caught === true) {
        caught += 1;
      } else if (result.caught === false) {
        missed += 1;
      }
      if (result.commandCaught === true) {
        commandCaught += 1;
      }
      if (result.targetCaught === true) {
        targetCaught += 1;
      }
    } else {
      passingCases += 1;
      if (result.falseAlarm === true) {
        falseAlarms += 1;
      }
    }

    allowlistRefusals += result.refusedCommands.length;
    if (result.error !== null) {
      errors += 1;
    }

    if (Number.isFinite(result.wallTimeMs)) {
      wallValues.push(result.wallTimeMs);
    }
    if (Number.isFinite(result.thinkMs)) {
      thinkValues.push(result.thinkMs);
    }
    if (result.tokPerSec !== null && Number.isFinite(result.tokPerSec)) {
      tokPerSecValues.push(result.tokPerSec);
    }
  }

  return {
    totalCases: results.length,
    failedCases,
    passingCases,
    caught,
    commandCaught,
    targetCaught,
    missed,
    falseAlarms,
    allowlistRefusals,
    errors,
    medianWallMs: percentile(wallValues, 50),
    p95WallMs: percentile(wallValues, 95),
    medianThinkMs: percentile(thinkValues, 50),
    medianTokPerSec: percentile(tokPerSecValues, 50),
  };
}
