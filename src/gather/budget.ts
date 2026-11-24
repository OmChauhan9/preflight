import type {
  BudgetContextParts,
  BudgetedContextResult,
  FileSnippet,
  WorkflowCommand,
} from './types.js';

export const DEFAULT_MAX_INPUT_TOKENS = 20_000;

const SECTION_SEPARATOR = '\n\n';
const TRUNCATION_SUFFIX = '\n...[truncated]';
const MAX_RECENT_CI_LOG_CHARS = 8_000;
const MAX_CI_COMMANDS_RESERVE_CHARS = 8_000;
const MAX_DIFF_CHANGED_FILES_DISPLAYED = 50;
const MIN_SNIPPET_BODY_CHARS = 24;
const RECENT_CI_LOG_WRAPPER_PREFIX = '## Recent CI Log\n```text\n';
const RECENT_CI_LOG_WRAPPER_SUFFIX = '\n```';
const RECENT_CI_LOG_WRAPPER_LENGTH =
  RECENT_CI_LOG_WRAPPER_PREFIX.length + RECENT_CI_LOG_WRAPPER_SUFFIX.length;
const RECENT_CI_LOG_MIN_VIABLE =
  '## Recent CI Log\n'.length + TRUNCATION_SUFFIX.length + MIN_SNIPPET_BODY_CHARS;
const CI_COMMANDS_MIN_VIABLE =
  '## CI Workflow Commands\n'.length + TRUNCATION_SUFFIX.length + MIN_SNIPPET_BODY_CHARS;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToMaxChars(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= TRUNCATION_SUFFIX.length) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function truncateTailToMaxChars(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  const prefix = '...[earlier log truncated]\n';
  if (maxChars <= prefix.length) {
    return text.slice(text.length - maxChars);
  }
  const keep = maxChars - prefix.length;
  return `${prefix}${text.slice(text.length - keep)}`;
}

function formatChangedFilesSummary(changedFiles: readonly string[]): string {
  if (changedFiles.length === 0) {
    return 'Changed files (0): (none)';
  }
  if (changedFiles.length <= MAX_DIFF_CHANGED_FILES_DISPLAYED) {
    return `Changed files (${changedFiles.length}): ${changedFiles.join(', ')}`;
  }
  const displayed = changedFiles.slice(0, MAX_DIFF_CHANGED_FILES_DISPLAYED);
  const omittedCount = changedFiles.length - MAX_DIFF_CHANGED_FILES_DISPLAYED;
  return `Changed files (${changedFiles.length}): ${displayed.join(', ')}, ... (+${omittedCount} more)`;
}

function formatGitDiffSection(
  baseRef: string,
  changedFiles: readonly string[],
  diff: string,
): string {
  const trimmedDiff = diff.trimEnd();
  return [
    `## Git Diff (base: ${baseRef})`,
    formatChangedFilesSummary(changedFiles),
    '',
    '```diff',
    trimmedDiff.length > 0 ? trimmedDiff : '(empty diff)',
    '```',
  ].join('\n');
}

function formatRecentCiLogSection(
  recentCiLog: string,
  maxTotalChars: number,
): { text: string; preTruncated: boolean } {
  const trimmedLog = recentCiLog.trimEnd();
  const maxBodyBudget = Math.max(
    0,
    Math.floor(maxTotalChars * 0.25) - RECENT_CI_LOG_WRAPPER_LENGTH,
  );
  const cap = Math.min(MAX_RECENT_CI_LOG_CHARS, maxBodyBudget);
  const preTruncated = trimmedLog.length > cap && cap > 0;
  const body = preTruncated ? truncateTailToMaxChars(trimmedLog, cap) : trimmedLog;
  return {
    text: `${RECENT_CI_LOG_WRAPPER_PREFIX}${body}${RECENT_CI_LOG_WRAPPER_SUFFIX}`,
    preTruncated,
  };
}

function formatCiCommandsSection(commands: readonly WorkflowCommand[]): string {
  const lines: string[] = ['## CI Workflow Commands'];
  if (commands.length === 0) {
    lines.push('(no workflow commands found)');
    return lines.join('\n');
  }

  for (const cmd of commands) {
    const meta: string[] = [cmd.file, `job: ${cmd.job}`];
    if (cmd.stepName) {
      meta.push(`step: ${cmd.stepName}`);
    }
    if (cmd.workingDirectory) {
      meta.push(`cwd: ${cmd.workingDirectory}`);
    }
    lines.push(`- [${meta.join(' | ')}] \`${cmd.command}\``);
  }

  return lines.join('\n');
}

function formatSingleSnippet(snippet: FileSnippet): string {
  return [`### ${snippet.path}`, '```', snippet.content.trimEnd(), '```'].join('\n');
}

function fitSnippetSection(
  heading: string,
  snippets: readonly FileSnippet[],
  availableChars: number,
): { text: string | null; truncated: boolean } {
  if (snippets.length === 0) {
    return { text: null, truncated: false };
  }

  const headerLine = `## ${heading}`;
  const fullBlocks = snippets.map(formatSingleSnippet);
  const fullSection = `${headerLine}\n${fullBlocks.join('\n\n')}`;
  if (fullSection.length <= availableChars) {
    return { text: fullSection, truncated: false };
  }

  const minViable = headerLine.length + 1 + TRUNCATION_SUFFIX.length + MIN_SNIPPET_BODY_CHARS;
  if (availableChars < minViable) {
    return { text: null, truncated: true };
  }

  let built = headerLine;
  for (let i = 0; i < snippets.length; i += 1) {
    const block = fullBlocks[i];
    if (block === undefined) {
      continue;
    }
    const separator = i === 0 ? '\n' : '\n\n';
    const remaining = availableChars - built.length - separator.length;
    if (remaining <= 0) {
      break;
    }

    if (block.length <= remaining) {
      built += `${separator}${block}`;
      continue;
    }

    const snippetHeader = `### ${snippets[i]?.path ?? ''}\n\`\`\`\n`;
    if (remaining >= snippetHeader.length + TRUNCATION_SUFFIX.length + MIN_SNIPPET_BODY_CHARS) {
      built += `${separator}${truncateToMaxChars(block, remaining)}`;
    }
    break;
  }

  if (built === headerLine) {
    return { text: null, truncated: true };
  }

  return { text: built, truncated: true };
}

interface TierSpec {
  name: string;
  render: (availableChars: number) => { text: string | null; truncated: boolean };
}

export function buildBudgetedContext(
  parts: BudgetContextParts,
  maxInputTokens: number = DEFAULT_MAX_INPUT_TOKENS,
): BudgetedContextResult {
  const safeMaxTokens = Number.isFinite(maxInputTokens)
    ? Math.max(0, Math.floor(maxInputTokens))
    : DEFAULT_MAX_INPUT_TOKENS;
  const maxChars = safeMaxTokens * 4;

  const affectedTestPaths = new Set(parts.affectedTests.map((snippet) => snippet.path));
  const nonDuplicateChangedFiles = parts.changedFileContents.filter(
    (snippet) => !affectedTestPaths.has(snippet.path),
  );

  if (maxChars === 0) {
    const dropped: string[] = [];
    if (parts.neighborContents.length > 0) dropped.push('neighbors');
    if (nonDuplicateChangedFiles.length > 0) dropped.push('changed_files');
    if (parts.affectedTests.length > 0) dropped.push('affected_tests');
    dropped.push('ci_commands');
    if (parts.recentCiLog && parts.recentCiLog.trim().length > 0) {
      dropped.push('recent_ci_log');
    }
    dropped.push('git_diff');
    return {
      budgetedContext: '',
      estimatedTokens: 0,
      truncatedSections: dropped,
    };
  }

  const gitDiffFull = formatGitDiffSection(parts.baseRef, parts.changedFiles, parts.diff);
  const ciCommandsFull = formatCiCommandsSection(parts.workflowCommands);
  const trimmedRecentLog = parts.recentCiLog?.trim() ?? '';
  const formattedLog =
    trimmedRecentLog.length > 0
      ? formatRecentCiLogSection(trimmedRecentLog, maxChars)
      : null;

  const maxRecentLogReserve =
    formattedLog !== null
      ? Math.min(
          MAX_RECENT_CI_LOG_CHARS + RECENT_CI_LOG_WRAPPER_LENGTH,
          Math.floor(maxChars * 0.25),
        )
      : 0;
  const recentLogMinNeeded =
    formattedLog !== null
      ? Math.min(formattedLog.text.length, RECENT_CI_LOG_MIN_VIABLE)
      : 0;
  const recentLogReserveContent =
    formattedLog !== null && maxRecentLogReserve >= recentLogMinNeeded
      ? Math.min(formattedLog.text.length, maxRecentLogReserve)
      : 0;
  const recentLogReserveTotal =
    recentLogReserveContent > 0 ? recentLogReserveContent + SECTION_SEPARATOR.length : 0;

  const maxCiCommandsReserve = Math.min(
    MAX_CI_COMMANDS_RESERVE_CHARS,
    Math.floor(maxChars * 0.15),
  );
  const ciCommandsMinNeeded = Math.min(ciCommandsFull.length, CI_COMMANDS_MIN_VIABLE);
  const ciCommandsReserveContent =
    maxCiCommandsReserve >= ciCommandsMinNeeded
      ? Math.min(ciCommandsFull.length, maxCiCommandsReserve)
      : 0;
  const ciCommandsReserveTotal =
    ciCommandsReserveContent > 0 ? ciCommandsReserveContent + SECTION_SEPARATOR.length : 0;

  // When an oversized diff would already overflow the budget (or crowd out recent_ci_log),
  // reserve bounded space for recent_ci_log tail and ci_commands while preserving strict
  // 5-tier drop priority whenever git_diff alone fits in the budget.
  const reserveForHigherSignal =
    gitDiffFull.length > maxChars ||
    (recentLogReserveTotal > 0 && gitDiffFull.length + recentLogReserveTotal > maxChars);

  const tiers: TierSpec[] = [
    {
      name: 'git_diff',
      render: (availableChars) => {
        const reservedTail = reserveForHigherSignal
          ? recentLogReserveTotal + ciCommandsReserveTotal
          : 0;
        const diffBudget = Math.max(0, availableChars - reservedTail);
        if (gitDiffFull.length <= diffBudget) {
          return { text: gitDiffFull, truncated: false };
        }
        return { text: truncateToMaxChars(gitDiffFull, diffBudget), truncated: true };
      },
    },
  ];

  if (formattedLog !== null) {
    tiers.push({
      name: 'recent_ci_log',
      render: (availableChars) => {
        const reservedForCi = reserveForHigherSignal ? ciCommandsReserveTotal : 0;
        const logBudget = Math.max(0, availableChars - reservedForCi);
        if (formattedLog.text.length <= logBudget) {
          return { text: formattedLog.text, truncated: formattedLog.preTruncated };
        }
        if (logBudget < RECENT_CI_LOG_MIN_VIABLE) {
          return { text: null, truncated: true };
        }
        const maxBodyChars = logBudget - RECENT_CI_LOG_WRAPPER_LENGTH;
        const tailBody = truncateTailToMaxChars(trimmedRecentLog, maxBodyChars);
        return {
          text: `${RECENT_CI_LOG_WRAPPER_PREFIX}${tailBody}${RECENT_CI_LOG_WRAPPER_SUFFIX}`,
          truncated: true,
        };
      },
    });
  }

  tiers.push({
    name: 'ci_commands',
    render: (availableChars) => {
      if (ciCommandsFull.length <= availableChars) {
        return { text: ciCommandsFull, truncated: false };
      }
      if (availableChars < CI_COMMANDS_MIN_VIABLE) {
        return { text: null, truncated: true };
      }
      return { text: truncateToMaxChars(ciCommandsFull, availableChars), truncated: true };
    },
  });

  if (parts.affectedTests.length > 0) {
    tiers.push({
      name: 'affected_tests',
      render: (availableChars) =>
        fitSnippetSection('Affected Tests', parts.affectedTests, availableChars),
    });
  }

  if (nonDuplicateChangedFiles.length > 0) {
    tiers.push({
      name: 'changed_files',
      render: (availableChars) =>
        fitSnippetSection('Changed Files', nonDuplicateChangedFiles, availableChars),
    });
  }

  if (parts.neighborContents.length > 0) {
    tiers.push({
      name: 'neighbors',
      render: (availableChars) =>
        fitSnippetSection('Neighbor Files', parts.neighborContents, availableChars),
    });
  }

  const includedSections: string[] = [];
  const truncatedInPriorityOrder: string[] = [];
  let usedChars = 0;

  for (const tier of tiers) {
    const separatorCost = includedSections.length > 0 ? SECTION_SEPARATOR.length : 0;
    const availableChars = maxChars - usedChars - separatorCost;

    if (availableChars <= 0) {
      truncatedInPriorityOrder.push(tier.name);
      continue;
    }

    const rendered = tier.render(availableChars);
    if (rendered.truncated) {
      truncatedInPriorityOrder.push(tier.name);
    }
    if (rendered.text !== null && rendered.text.length > 0) {
      includedSections.push(rendered.text);
      usedChars += separatorCost + rendered.text.length;
    }
  }

  let budgetedContext = includedSections.join(SECTION_SEPARATOR);
  if (budgetedContext.length > maxChars) {
    budgetedContext = budgetedContext.slice(0, maxChars);
  }

  const truncatedSections = truncatedInPriorityOrder.reverse();

  return {
    budgetedContext,
    estimatedTokens: estimateTokens(budgetedContext),
    truncatedSections,
  };
}
