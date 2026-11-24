import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowCommand } from './types.js';

interface ParsedKeyValue {
  key: string;
  value: string;
}

interface ParsedBlockScalarHeader {
  style: '|' | '>';
  explicitIndent: number | null;
}

interface PendingStep {
  stepName?: string;
  workingDirectory?: string;
  runBlocks: string[];
}

function countLeadingSpaces(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === ' ') {
      count += 1;
    } else if (ch === '\t') {
      count += 2;
    } else {
      break;
    }
  }
  return count;
}

function stripUnquotedComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '#') {
      const prev = i > 0 ? raw[i - 1] : undefined;
      if (i === 0 || prev === ' ' || prev === '\t') {
        return raw.slice(0, i).trimEnd();
      }
    }
  }

  return raw.trimEnd();
}

function unquoteYamlScalar(raw: string): string {
  const cleaned = stripUnquotedComment(raw).trim();
  if (cleaned.length === 0) {
    return '';
  }

  if (cleaned.length >= 2 && cleaned.startsWith("'") && cleaned.endsWith("'")) {
    return cleaned.slice(1, -1).replace(/''/g, "'");
  }

  if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"')) {
    const inner = cleaned.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch !== '\\') {
        out += ch ?? '';
        continue;
      }
      const next = inner[i + 1];
      if (next === undefined) {
        out += '\\';
        break;
      }
      i += 1;
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        default:
          out += next;
          break;
      }
    }
    return out;
  }

  return cleaned;
}

function parseYamlKeyValue(trimmed: string): ParsedKeyValue | null {
  let key: string;
  let afterColonIdx: number;

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    let endQuote = -1;
    for (let i = 1; i < trimmed.length; i += 1) {
      if (quote === '"' && trimmed[i] === '\\') {
        i += 1;
        continue;
      }
      if (trimmed[i] === quote) {
        if (quote === "'" && trimmed[i + 1] === "'") {
          i += 1;
          continue;
        }
        endQuote = i;
        break;
      }
    }
    if (endQuote === -1) {
      return null;
    }
    const rest = trimmed.slice(endQuote + 1).trimStart();
    if (!rest.startsWith(':')) {
      return null;
    }
    const afterColonChar = rest[1];
    if (afterColonChar !== undefined && afterColonChar !== ' ' && afterColonChar !== '\t') {
      return null;
    }
    key = unquoteYamlScalar(trimmed.slice(0, endQuote + 1));
    afterColonIdx = trimmed.indexOf(':', endQuote + 1) + 1;
  } else {
    const match = /^([A-Za-z0-9_.-]+)\s*:(?:[ \t]+(.*)|[ \t]*)$/.exec(trimmed);
    if (!match?.[1]) {
      return null;
    }
    return {
      key: match[1],
      value: (match[2] ?? '').trim(),
    };
  }

  return {
    key,
    value: trimmed.slice(afterColonIdx).trim(),
  };
}

function parseBlockScalarHeader(rawValue: string): ParsedBlockScalarHeader | null {
  const cleaned = stripUnquotedComment(rawValue).trim();
  const match = /^([|>])(?:([+-])?([1-9])?|([1-9])?([+-])?)$/.exec(cleaned);
  if (!match) {
    return null;
  }
  const style = match[1];
  if (style !== '|' && style !== '>') {
    return null;
  }
  const digitStr = match[3] ?? match[4];
  const explicitIndent = digitStr !== undefined ? Number.parseInt(digitStr, 10) : null;
  return { style, explicitIndent };
}

function foldBlockLines(lines: readonly string[]): string {
  const outputLines: string[] = [];
  let paragraph = '';

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      outputLines.push(paragraph);
      paragraph = '';
    }
  };

  for (const line of lines) {
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    if (/^\s+/.test(line)) {
      flushParagraph();
      outputLines.push(line);
      continue;
    }

    paragraph = paragraph.length === 0 ? line : `${paragraph} ${line}`;
  }

  flushParagraph();
  return outputLines.join('\n');
}

function readBlockScalar(
  lines: readonly string[],
  startIndex: number,
  parentIndent: number,
  header: ParsedBlockScalarHeader,
): { text: string; nextIndex: number } {
  const collected: Array<{ indent: number; raw: string; blank: boolean }> = [];
  let contentIndent: number | null =
    header.explicitIndent !== null ? parentIndent + header.explicitIndent : null;

  let i = startIndex;
  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      break;
    }

    if (rawLine.trim().length === 0) {
      collected.push({ indent: 0, raw: '', blank: true });
      i += 1;
      continue;
    }

    const indent = countLeadingSpaces(rawLine);
    if (indent <= parentIndent) {
      break;
    }

    if (header.explicitIndent === null) {
      contentIndent = contentIndent === null ? indent : Math.min(contentIndent, indent);
    }

    collected.push({ indent, raw: rawLine, blank: false });
    i += 1;
  }

  while (collected.length > 0 && collected[collected.length - 1]?.blank) {
    collected.pop();
  }

  const effectiveIndent = contentIndent ?? parentIndent + 2;
  const dedented = collected.map((entry) => {
    if (entry.blank) {
      return '';
    }
    return entry.raw.slice(Math.min(effectiveIndent, entry.raw.length));
  });

  const text = header.style === '>' ? foldBlockLines(dedented) : dedented.join('\n');
  return { text, nextIndex: i };
}

function hasTrailingBackslashContinuation(trimmedLine: string): boolean {
  let count = 0;
  for (let i = trimmedLine.length - 1; i >= 0; i -= 1) {
    if (trimmedLine[i] === '\\') {
      count += 1;
    } else {
      break;
    }
  }
  return count % 2 === 1;
}

export function splitShellCommands(rawScript: string): string[] {
  const lines = rawScript.replace(/\r\n?/g, '\n').split('\n');
  const commands: string[] = [];
  let buffer = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      if (buffer.length > 0) {
        commands.push(buffer);
        buffer = '';
      }
      continue;
    }

    if (buffer.length === 0 && trimmed.startsWith('#')) {
      continue;
    }

    const hasContinuation = hasTrailingBackslashContinuation(trimmed);
    const piece = hasContinuation ? trimmed.slice(0, -1).trimEnd() : trimmed;

    if (buffer.length === 0) {
      buffer = piece;
    } else if (piece.length > 0) {
      buffer = `${buffer} ${piece}`;
    }

    if (!hasContinuation && buffer.length > 0) {
      commands.push(buffer);
      buffer = '';
    }
  }

  if (buffer.length > 0) {
    commands.push(buffer);
  }

  return commands;
}

export function parseWorkflowYaml(file: string, content: string): WorkflowCommand[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const results: WorkflowCommand[] = [];

  let workflowDefaultWorkingDir: string | undefined;
  let inTopDefaults = false;
  let topDefaultsIndent = -1;
  let inTopDefaultsRun = false;
  let topDefaultsRunIndent = -1;

  let inJobs = false;
  let jobsIndent = -1;

  let currentJob: string | null = null;
  let jobIdIndent = -1;
  let jobPropIndent = -1;
  let jobWorkingDir: string | undefined;
  let inJobDefaults = false;
  let jobDefaultsIndent = -1;
  let inJobDefaultsRun = false;
  let jobDefaultsRunIndent = -1;

  let inSteps = false;
  let stepsKeyIndent = -1;
  let stepDashIndent = -1;
  let stepKeyIndent = -1;
  let currentStep: PendingStep | null = null;

  const flushStep = (): void => {
    if (!currentStep || currentJob === null) {
      currentStep = null;
      return;
    }

    const effectiveWorkingDir =
      currentStep.workingDirectory ?? jobWorkingDir ?? workflowDefaultWorkingDir;

    for (const block of currentStep.runBlocks) {
      for (const command of splitShellCommands(block)) {
        const entry: WorkflowCommand = {
          file,
          job: currentJob,
          command,
        };
        if (currentStep.stepName !== undefined && currentStep.stepName.length > 0) {
          entry.stepName = currentStep.stepName;
        }
        if (effectiveWorkingDir !== undefined && effectiveWorkingDir.length > 0) {
          entry.workingDirectory = effectiveWorkingDir;
        }
        results.push(entry);
      }
    }

    currentStep = null;
  };

  const resetJobState = (): void => {
    flushStep();
    currentJob = null;
    jobPropIndent = -1;
    jobWorkingDir = undefined;
    inJobDefaults = false;
    jobDefaultsIndent = -1;
    inJobDefaultsRun = false;
    jobDefaultsRunIndent = -1;
    inSteps = false;
    stepsKeyIndent = -1;
    stepDashIndent = -1;
    stepKeyIndent = -1;
  };

  const applyStepKeyValue = (
    kv: ParsedKeyValue,
    keyIndent: number,
    lineIndex: number,
  ): number => {
    if (!currentStep) {
      return lineIndex + 1;
    }

    if (kv.key === 'name') {
      const value = unquoteYamlScalar(kv.value);
      if (value.length > 0) {
        currentStep.stepName = value;
      }
      return lineIndex + 1;
    }

    if (kv.key === 'working-directory') {
      const value = unquoteYamlScalar(kv.value);
      if (value.length > 0) {
        currentStep.workingDirectory = value;
      }
      return lineIndex + 1;
    }

    if (kv.key === 'run') {
      const blockHeader = parseBlockScalarHeader(kv.value);
      if (blockHeader !== null) {
        const { text, nextIndex } = readBlockScalar(
          lines,
          lineIndex + 1,
          keyIndent,
          blockHeader,
        );
        currentStep.runBlocks.push(text);
        return nextIndex;
      }
      const scalar = unquoteYamlScalar(kv.value);
      if (scalar.length > 0) {
        currentStep.runBlocks.push(scalar);
      }
      return lineIndex + 1;
    }

    return lineIndex + 1;
  };

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      break;
    }

    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') {
      i += 1;
      continue;
    }

    const indent = countLeadingSpaces(rawLine);

    if (inTopDefaults && indent <= topDefaultsIndent) {
      inTopDefaults = false;
      inTopDefaultsRun = false;
      topDefaultsIndent = -1;
      topDefaultsRunIndent = -1;
    } else if (inTopDefaultsRun && indent <= topDefaultsRunIndent) {
      inTopDefaultsRun = false;
      topDefaultsRunIndent = -1;
    }

    if (inJobs && indent <= jobsIndent) {
      resetJobState();
      inJobs = false;
      jobsIndent = -1;
      jobIdIndent = -1;
    }

    if (!inJobs) {
      const kv = parseYamlKeyValue(trimmed);
      if (kv !== null) {
        if (indent === 0 && kv.key === 'jobs') {
          inJobs = true;
          jobsIndent = indent;
          jobIdIndent = -1;
          i += 1;
          continue;
        }
        if (indent === 0 && kv.key === 'defaults') {
          inTopDefaults = true;
          topDefaultsIndent = indent;
          i += 1;
          continue;
        }
        if (inTopDefaults && !inTopDefaultsRun && indent > topDefaultsIndent && kv.key === 'run') {
          inTopDefaultsRun = true;
          topDefaultsRunIndent = indent;
          i += 1;
          continue;
        }
        if (inTopDefaultsRun && indent > topDefaultsRunIndent && kv.key === 'working-directory') {
          const val = unquoteYamlScalar(kv.value);
          if (val.length > 0) {
            workflowDefaultWorkingDir = val;
          }
        }
      }
      i += 1;
      continue;
    }

    if (jobIdIndent === -1) {
      jobIdIndent = indent;
    }

    if (indent === jobIdIndent) {
      resetJobState();
      const kv = parseYamlKeyValue(trimmed);
      if (kv !== null) {
        currentJob = kv.key;
      }
      i += 1;
      continue;
    }

    if (currentJob === null) {
      i += 1;
      continue;
    }

    if (jobPropIndent === -1 && indent > jobIdIndent) {
      jobPropIndent = indent;
    }

    if (inJobDefaults && indent <= jobDefaultsIndent) {
      inJobDefaults = false;
      inJobDefaultsRun = false;
      jobDefaultsIndent = -1;
      jobDefaultsRunIndent = -1;
    } else if (inJobDefaultsRun && indent <= jobDefaultsRunIndent) {
      inJobDefaultsRun = false;
      jobDefaultsRunIndent = -1;
    }

    if (inSteps) {
      const isSequenceDash = trimmed === '-' || /^-[ \t]/.test(trimmed);
      const leavesSteps =
        indent < stepsKeyIndent ||
        (indent === stepsKeyIndent && !isSequenceDash) ||
        (stepDashIndent !== -1 && indent < stepDashIndent);

      if (leavesSteps) {
        flushStep();
        inSteps = false;
        stepsKeyIndent = -1;
        stepDashIndent = -1;
        stepKeyIndent = -1;
      }
    }

    if (inSteps) {
      const isSequenceDash = trimmed === '-' || /^-[ \t]/.test(trimmed);
      if (isSequenceDash && (stepDashIndent === -1 || indent === stepDashIndent)) {
        flushStep();
        stepDashIndent = indent;
        currentStep = { runBlocks: [] };

        if (trimmed === '-') {
          stepKeyIndent = -1;
          i += 1;
          continue;
        }

        const afterDash = trimmed.slice(1);
        const spacesAfterDash = countLeadingSpaces(afterDash);
        stepKeyIndent = indent + 1 + spacesAfterDash;
        const remainder = afterDash.trim();
        const kv = parseYamlKeyValue(remainder);
        if (kv !== null) {
          i = applyStepKeyValue(kv, stepKeyIndent, i);
          continue;
        }

        i += 1;
        continue;
      }

      if (currentStep !== null) {
        if (stepKeyIndent === -1 && indent > stepDashIndent) {
          stepKeyIndent = indent;
        }
        if (indent === stepKeyIndent) {
          const kv = parseYamlKeyValue(trimmed);
          if (kv !== null) {
            i = applyStepKeyValue(kv, stepKeyIndent, i);
            continue;
          }
        }
      }

      i += 1;
      continue;
    }

    const kv = parseYamlKeyValue(trimmed);
    if (kv !== null) {
      if (inJobDefaultsRun && indent > jobDefaultsRunIndent && kv.key === 'working-directory') {
        const val = unquoteYamlScalar(kv.value);
        if (val.length > 0) {
          jobWorkingDir = val;
        }
        i += 1;
        continue;
      }

      if (inJobDefaults && !inJobDefaultsRun && indent > jobDefaultsIndent && kv.key === 'run') {
        inJobDefaultsRun = true;
        jobDefaultsRunIndent = indent;
        i += 1;
        continue;
      }

      if (indent === jobPropIndent && !inJobDefaults) {
        if (kv.key === 'steps') {
          inSteps = true;
          stepsKeyIndent = indent;
          stepDashIndent = -1;
          stepKeyIndent = -1;
          i += 1;
          continue;
        }

        if (kv.key === 'defaults') {
          inJobDefaults = true;
          jobDefaultsIndent = indent;
          i += 1;
          continue;
        }

        if (kv.key === 'working-directory') {
          const val = unquoteYamlScalar(kv.value);
          if (val.length > 0) {
            jobWorkingDir = val;
          }
          i += 1;
          continue;
        }
      }
    }

    i += 1;
  }

  flushStep();
  return results;
}

export function loadWorkflowCommands(cwd: string): WorkflowCommand[] {
  const workflowsDir = join(cwd, '.github', 'workflows');
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const workflowFiles = entries
    .filter((entry) => {
      if (!entry.isFile()) {
        return false;
      }
      const lower = entry.name.toLowerCase();
      return lower.endsWith('.yml') || lower.endsWith('.yaml');
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const commands: WorkflowCommand[] = [];
  for (const fileName of workflowFiles) {
    const fullPath = join(workflowsDir, fileName);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const repoRelPath = `.github/workflows/${fileName}`;
    commands.push(...parseWorkflowYaml(repoRelPath, content));
  }

  return commands;
}
