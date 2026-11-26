import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { checkCommandAllowlist, hasPathTraversal } from './allowlist.js';
import { executeCommand } from './runner.js';
import {
  DEFAULT_MAX_COMMANDS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type CommandCheckResult,
  type RefusedCommand,
  type VerifyOptions,
  type VerifyResult,
  type VerifyVerdict,
  type VerifyVerdictMessage,
  type VerifyWorkflowCommand,
} from './types.js';

export {
  DEFAULT_MAX_COMMANDS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type AllowlistDecision,
  type CheckAllowlistOptions,
  type CommandCheckResult,
  type CommandCheckStatus,
  type ExecuteCommandOptions,
  type ExecuteCommandResult,
  type RefusedCommand,
  type SpawnCommandFn,
  type TokenizeResult,
  type VerifyOptions,
  type VerifyResult,
  type VerifyVerdict,
  type VerifyVerdictMessage,
  type VerifyWorkflowCommand,
} from './types.js';
export {
  checkCommandAllowlist,
  extractCommandSignature,
  tokenizeCommand,
} from './allowlist.js';
export { executeCommand, STRIPPED_CHILD_ENV_KEYS } from './runner.js';

function isPathInsideRoot(rootDir: string, targetPath: string): boolean {
  const rel = relative(rootDir, targetPath);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

function resolveExecutionCwd(
  repoRoot: string,
  workingDirectory?: string,
): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (workingDirectory === undefined || workingDirectory.trim().length === 0) {
    return { ok: true, cwd: repoRoot };
  }

  if (
    hasPathTraversal(workingDirectory) ||
    isAbsolute(workingDirectory) ||
    /^[A-Za-z]:/.test(workingDirectory) ||
    workingDirectory.startsWith('~') ||
    workingDirectory.startsWith('\\')
  ) {
    return {
      ok: false,
      reason: `Unsafe workflow workingDirectory "${workingDirectory}": must stay inside repository root`,
    };
  }

  const resolved = resolve(repoRoot, workingDirectory);
  if (!isPathInsideRoot(repoRoot, resolved)) {
    return {
      ok: false,
      reason: `Unsafe workflow workingDirectory "${workingDirectory}": escapes repository root`,
    };
  }

  if (existsSync(repoRoot)) {
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = realpathSync(repoRoot);
      realTarget = realpathSync(resolved);
      if (!statSync(realTarget).isDirectory()) {
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

    if (!isPathInsideRoot(realRoot, realTarget)) {
      return {
        ok: false,
        reason: `Unsafe workflow workingDirectory "${workingDirectory}": symlink resolves outside repository root`,
      };
    }
  }

  return { ok: true, cwd: resolved };
}

export async function runVerify(
  candidateCommands: readonly string[],
  workflowCommands: readonly VerifyWorkflowCommand[],
  options: VerifyOptions,
): Promise<VerifyResult> {
  const verifyStart = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxCommands =
    options.maxCommands !== undefined &&
    Number.isFinite(options.maxCommands) &&
    options.maxCommands >= 0
      ? Math.floor(options.maxCommands)
      : DEFAULT_MAX_COMMANDS;
  const spawnCommand = options.spawnCommand ?? executeCommand;
  const repoRoot = resolve(options.cwd);

  const results: CommandCheckResult[] = [];
  const refusedCommands: RefusedCommand[] = [];
  const seenCommands = new Set<string>();
  const seenExecutions = new Set<string>();
  let executedCount = 0;
  let hasFailure = false;

  for (const command of candidateCommands) {
    const normalizedCommand = command.trim();
    if (seenCommands.has(normalizedCommand)) {
      continue;
    }
    seenCommands.add(normalizedCommand);

    const decision = checkCommandAllowlist(command, workflowCommands, {
      cwd: repoRoot,
    });

    if (!decision.allowed) {
      refusedCommands.push({ command, reason: decision.reason });
      results.push({
        command,
        status: 'refused',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        refusalReason: decision.reason,
      });
      continue;
    }

    const cwdResolution = resolveExecutionCwd(repoRoot, decision.workingDirectory);
    if (!cwdResolution.ok) {
      refusedCommands.push({ command, reason: cwdResolution.reason });
      results.push({
        command,
        status: 'refused',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        refusalReason: cwdResolution.reason,
      });
      continue;
    }

    const executionKey = JSON.stringify([
      cwdResolution.cwd,
      decision.binary,
      ...decision.args,
    ]);
    if (seenExecutions.has(executionKey)) {
      continue;
    }
    seenExecutions.add(executionKey);

    if (executedCount >= maxCommands) {
      const reason = `Exceeded maximum commands per verify run (${maxCommands})`;
      refusedCommands.push({ command, reason });
      results.push({
        command,
        status: 'refused',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        refusalReason: reason,
      });
      continue;
    }

    const execResult = await spawnCommand(decision.binary, decision.args, {
      cwd: cwdResolution.cwd,
      timeoutMs,
      maxOutputBytes,
    });
    executedCount += 1;

    const status: 'passed' | 'failed' | 'timed_out' =
      execResult.status === 'timed_out'
        ? 'timed_out'
        : execResult.exitCode === 0 && execResult.status === 'passed'
          ? 'passed'
          : 'failed';

    if (status !== 'passed') {
      hasFailure = true;
    }

    results.push({
      command,
      status,
      exitCode: execResult.exitCode,
      durationMs: execResult.durationMs,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      matchedWorkflowCommand: decision.matchedWorkflowCommand,
    });
  }

  let verdict: VerifyVerdict;
  let verdictMessage: VerifyVerdictMessage;

  if (executedCount === 0) {
    verdict = 'no_checks_run';
    verdictMessage = 'no allowlisted checks were executed';
  } else if (hasFailure) {
    verdict = 'failed';
    verdictMessage = 'these checks failed';
  } else {
    verdict = 'passed';
    verdictMessage = 'these checks passed';
  }

  return {
    verdict,
    verdictMessage,
    results,
    refusedCommands,
    durationMs: Math.max(0, Math.round(performance.now() - verifyStart)),
  };
}
