import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';

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

describe('preflight CLI skeleton', () => {
  it.each(['check', 'explain', 'bench'])('prints "not implemented" for %s', (command) => {
    const captured = createCapturedIo();
    const code = runCli([command], captured.io);

    expect(code).toBe(0);
    expect(captured.stdout).toEqual(['not implemented']);
    expect(captured.stderr).toEqual([]);
  });

  it('accepts --provider, --json, and --think flags without crashing', () => {
    const captured = createCapturedIo();
    const code = runCli(
      ['check', '--provider', 'moonshot', '--json', '--think'],
      captured.io,
    );

    expect(code).toBe(0);
    expect(captured.stdout).toEqual(['not implemented']);
    expect(captured.stderr).toEqual([]);
  });

  it('accepts --provider=<name> and flags before the subcommand', () => {
    const captured = createCapturedIo();
    const code = runCli(
      ['--json', '--provider=cerebras', 'explain', 'ci.log'],
      captured.io,
    );

    expect(code).toBe(0);
    expect(captured.stdout).toEqual(['not implemented']);
    expect(captured.stderr).toEqual([]);
  });

  it('prints usage for --help, -h, and empty arguments', () => {
    for (const argv of [['--help'], ['-h'], [], ['check', '--help']]) {
      const captured = createCapturedIo();
      const code = runCli(argv, captured.io);

      expect(code).toBe(0);
      expect(captured.stdout.join('\n')).toContain('Usage: preflight <command>');
      expect(captured.stderr).toEqual([]);
    }
  });

  it('returns exit code 1 for an unknown command', () => {
    const captured = createCapturedIo();
    const code = runCli(['unknown-cmd'], captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('\n')).toContain('Unknown command: unknown-cmd');
  });

  it('returns exit code 1 when --provider is missing a value', () => {
    const captured = createCapturedIo();
    const code = runCli(['check', '--provider'], captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('\n')).toContain('Missing value for --provider');
  });
});
