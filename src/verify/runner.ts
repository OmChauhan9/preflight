import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type ExecuteCommandOptions,
  type ExecuteCommandResult,
} from './types.js';

const MAX_KILL_GRACE_MS = 2_000;
const MIN_KILL_GRACE_MS = 50;

export const STRIPPED_CHILD_ENV_KEYS: readonly string[] = [
  'PREFLIGHT_API_KEY',
  'OLLAMA_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'CEREBRAS_API_KEY',
];

const STRIPPED_CHILD_ENV_SET: ReadonlySet<string> = new Set(
  STRIPPED_CHILD_ENV_KEYS,
);

function buildSanitizedChildEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }
    if (STRIPPED_CHILD_ENV_SET.has(key.toUpperCase())) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function terminateChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
): void {
  const pid = child.pid;
  if (useProcessGroup && pid !== undefined && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fallback to direct child.kill() if process group no longer exists or is unreachable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already have exited before signal was delivered.
  }
}

class BoundedTailBuffer {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    if (this.maxBytes === 0) {
      this.truncated = true;
      return;
    }

    if (chunk.length >= this.maxBytes) {
      const hadOverflow = this.totalBytes > 0 || chunk.length > this.maxBytes;
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)];
      this.totalBytes = this.maxBytes;
      if (hadOverflow) {
        this.truncated = true;
      }
      return;
    }

    this.chunks.push(chunk);
    this.totalBytes += chunk.length;

    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.totalBytes - this.maxBytes;
      const head = this.chunks[0];
      if (head === undefined) {
        break;
      }
      if (head.length <= overflow) {
        this.chunks.shift();
        this.totalBytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.totalBytes -= overflow;
      }
      this.truncated = true;
    }
  }

  toString(): string {
    if (this.chunks.length === 0) {
      return '';
    }
    const combined = Buffer.concat(this.chunks, this.totalBytes);
    let start = 0;
    if (this.truncated) {
      while (start < combined.length) {
        const byte = combined[start];
        if (byte === undefined || (byte & 0xc0) !== 0x80) {
          break;
        }
        start += 1;
      }
    }
    return combined.subarray(start).toString('utf8');
  }
}

export function executeCommand(
  binary: string,
  args: readonly string[],
  options: ExecuteCommandOptions,
): Promise<ExecuteCommandResult> {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxOutputBytes =
    Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes >= 0
      ? options.maxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = Math.min(
    MAX_KILL_GRACE_MS,
    Math.max(MIN_KILL_GRACE_MS, timeoutMs),
  );

  const startMs = performance.now();
  const stdoutBuf = new BoundedTailBuffer(maxOutputBytes);
  const stderrBuf = new BoundedTailBuffer(maxOutputBytes);

  return new Promise<ExecuteCommandResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const finalize = (result: ExecuteCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      resolve(result);
    };

    const useProcessGroup = process.platform !== 'win32';
    let child: ChildProcess;
    try {
      child = spawn(binary, [...args], {
        cwd: options.cwd,
        env: buildSanitizedChildEnv(),
        shell: false,
        detached: useProcessGroup,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      finalize({
        status: 'failed',
        exitCode: null,
        durationMs: Math.max(0, Math.round(performance.now() - startMs)),
        stdout: '',
        stderr: message,
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuf.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuf.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      terminateChildProcess(child, 'SIGTERM', useProcessGroup);
      killTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        terminateChildProcess(child, 'SIGKILL', useProcessGroup);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, killGraceMs);
    }, timeoutMs);

    child.on('error', (error: Error) => {
      const capturedStderr = stderrBuf.toString();
      const stderr =
        capturedStderr.length > 0
          ? `${capturedStderr}\n${error.message}`
          : error.message;
      finalize({
        status: 'failed',
        exitCode: null,
        durationMs: Math.max(0, Math.round(performance.now() - startMs)),
        stdout: stdoutBuf.toString(),
        stderr,
      });
    });

    child.on('close', (code: number | null) => {
      const durationMs = Math.max(0, Math.round(performance.now() - startMs));
      const stdout = stdoutBuf.toString();
      const capturedStderr = stderrBuf.toString();

      if (timedOut) {
        const stderr =
          capturedStderr.length > 0
            ? capturedStderr
            : `Command timed out after ${timeoutMs}ms`;
        finalize({
          status: 'timed_out',
          exitCode: null,
          durationMs,
          stdout,
          stderr,
        });
        return;
      }

      finalize({
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        durationMs,
        stdout,
        stderr: capturedStderr,
      });
    });
  });
}
