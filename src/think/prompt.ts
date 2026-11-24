import type { ChatMessage } from '../clients/types.js';
import type { ThinkInput } from './types.js';

const MAX_HEADER_ITEMS = 50;

const EXAMPLE_OUTPUT = JSON.stringify(
  {
    likely_failures: [
      {
        category: 'test',
        target: 'test/client.test.ts',
        reason:
          'Diff modifies retry header parsing in src/clients/http.ts imported by test/client.test.ts',
        file: 'src/clients/http.ts',
        line: 98,
        confidence: 0.85,
      },
    ],
    affected_jobs: ['test', 'typecheck'],
    commands: ['npx vitest run test/client.test.ts', 'npm run typecheck'],
    notes:
      'Retry-After parsing logic changed; run unit tests for HTTP client and full typecheck.',
  },
  null,
  2,
);

const THINK_SYSTEM_PROMPT = [
  'You are Preflight, a fast local CI triage engine.',
  'Inspect the provided repository context (git diff, changed files, static import/test relationships, and CI workflow commands), predict the most likely CI failures, and select the minimal scoped CI commands to run locally.',
  '',
  'STRICT OUTPUT CONTRACT:',
  '- Return ONLY a single raw JSON object. Do NOT output prose, commentary, or markdown code fences (no ```json or ```).',
  '- Top-level JSON object MUST contain these exact required fields:',
  '  - "likely_failures": array of objects with required non-empty strings "category" (e.g. "test", "typecheck", "lint"), "target", and "reason", plus optional "file" (non-empty string), "line" (positive integer), and "confidence" (number in [0, 1]).',
  '  - "affected_jobs": array of non-empty strings naming impacted CI job IDs from the provided workflow commands.',
  '  - "commands": array of non-empty strings listing the minimal scoped commands to execute locally.',
  '  - "notes": concise string summarizing what is being checked and why.',
  '',
  'COMMAND SCOPING RULES (CRITICAL):',
  '- ONLY suggest scoped versions of the provided CI workflow commands using the exact same tool and subcommand (e.g., narrowing a test runner or linter to specific changed files or affected test files).',
  '- NEVER invent unrelated shell commands, package installs, or arbitrary shell chaining/redirection (never use ";", "&&", "||", "|", backticks, "$(...)", ">", "<", or ".." path traversal).',
  '- Keep "commands" minimal, non-redundant, and targeted to the changed files and affected tests. If no workflow commands apply, return empty arrays.',
  '',
  'EXAMPLE JSON OUTPUT:',
  EXAMPLE_OUTPUT,
].join('\n');

function formatChangedFilesSection(changedFiles: readonly string[]): string | null {
  if (changedFiles.length === 0) {
    return null;
  }

  const displayed = changedFiles.slice(0, MAX_HEADER_ITEMS);
  const lines = ['Changed files:', ...displayed.map((file) => `- ${file}`)];
  if (changedFiles.length > MAX_HEADER_ITEMS) {
    lines.push(`- ... (+${changedFiles.length - MAX_HEADER_ITEMS} more)`);
  }
  return lines.join('\n');
}

function formatWorkflowCommandsSection(
  workflowCommands: ThinkInput['workflowCommands'],
): string | null {
  if (workflowCommands.length === 0) {
    return null;
  }

  const displayed = workflowCommands.slice(0, MAX_HEADER_ITEMS);
  const lines = [
    'Allowed CI workflow commands (derive scoped commands ONLY from these):',
    ...displayed.map((entry) => `- [${entry.job}] (${entry.file}): ${entry.command}`),
  ];
  if (workflowCommands.length > MAX_HEADER_ITEMS) {
    lines.push(`- ... (+${workflowCommands.length - MAX_HEADER_ITEMS} more)`);
  }
  return lines.join('\n');
}

/**
 * Builds the initial `[system, user]` chat messages for the Think stage.
 */
export function buildThinkMessages(input: ThinkInput): ChatMessage[] {
  const userSections: string[] = [];

  const changedFilesSection = formatChangedFilesSection(input.changedFiles);
  if (changedFilesSection !== null) {
    userSections.push(changedFilesSection);
  }

  const workflowCommandsSection = formatWorkflowCommandsSection(input.workflowCommands);
  if (workflowCommandsSection !== null) {
    userSections.push(workflowCommandsSection);
  }

  userSections.push(
    'Budgeted repository context:',
    input.budgetedContext,
    'Respond with ONLY a valid raw JSON object matching the required schema.',
  );

  return [
    { role: 'system', content: THINK_SYSTEM_PROMPT },
    { role: 'user', content: userSections.join('\n\n') },
  ];
}

/**
 * Builds the single error-feedback retry conversation by appending the model's
 * invalid response and a concise user prompt listing the exact validation errors.
 */
export function buildRetryMessages(
  originalMessages: readonly ChatMessage[],
  badOutput: string,
  errors: readonly string[],
): ChatMessage[] {
  const errorLines =
    errors.length > 0
      ? errors.map((err) => `- ${err}`).join('\n')
      : '- Output did not conform to the required ThinkOutput JSON schema.';

  const assistantOutput =
    badOutput.trim().length > 0 ? badOutput : '(empty response)';

  const correctionMessage = [
    'Your previous response failed JSON validation with the following error(s):',
    errorLines,
    '',
    'Fix these errors and return ONLY a single valid raw JSON object with required fields:',
    '"likely_failures" (array), "affected_jobs" (string[]), "commands" (string[]), and "notes" (string).',
    'Do not include any prose or markdown code fences.',
  ].join('\n');

  return [
    ...originalMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: 'assistant', content: assistantOutput },
    { role: 'user', content: correctionMessage },
  ];
}
