import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';
import { PROVIDER_NAMES } from '../src/clients/providers.js';

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

  it.each(PROVIDER_NAMES)(
    'accepts --provider %s with --model, --json, and --think flags',
    (provider) => {
      const captured = createCapturedIo();
      const code = runCli(
        ['check', '--provider', provider, '--model', 'qwen2.5-coder:7b', '--json', '--think'],
        captured.io,
      );

      expect(code).toBe(0);
      expect(captured.stdout).toEqual(['not implemented']);
      expect(captured.stderr).toEqual([]);
    },
  );

  it('accepts --provider=<name>, --model=<name>, and flags before the subcommand', () => {
    const captured = createCapturedIo();
    const code = runCli(
      ['--json', '--provider=groq', '--model=llama-3.3-70b-versatile', 'explain', 'ci.log'],
      captured.io,
    );

    expect(code).toBe(0);
    expect(captured.stdout).toEqual(['not implemented']);
    expect(captured.stderr).toEqual([]);
  });

  it('prints provider-agnostic usage with ollama default for --help, -h, and empty args', () => {
    for (const argv of [['--help'], ['-h'], [], ['check', '--help']]) {
      const captured = createCapturedIo();
      const code = runCli(argv, captured.io);
      const output = captured.stdout.join('\n');

      expect(code).toBe(0);
      expect(output).toContain('Usage: preflight <command>');
      expect(output).toContain(
        '--provider <ollama|groq|gemini|openrouter|openai|cerebras|custom>',
      );
      expect(output).toContain('default: ollama');
      expect(output).toContain('--model <name>');
      expect(output).not.toContain('Phase 0');
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

  it('returns exit code 1 for an unknown option', () => {
    const captured = createCapturedIo();
    const code = runCli(['check', '--unknown-flag'], captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('\n')).toContain('Unknown option: --unknown-flag');
  });

  it('returns exit code 1 when --provider is missing a value', () => {
    for (const argv of [
      ['check', '--provider'],
      ['check', '--provider='],
      ['check', '--provider', '--json'],
    ]) {
      const captured = createCapturedIo();
      const code = runCli(argv, captured.io);

      expect(code).toBe(1);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr.join('\n')).toContain('Missing value for --provider');
    }
  });

  it('returns exit code 1 when --provider is unknown', () => {
    for (const argv of [
      ['check', '--provider', 'unknown-provider'],
      ['check', '--provider=unknown-provider'],
    ]) {
      const captured = createCapturedIo();
      const code = runCli(argv, captured.io);

      expect(code).toBe(1);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr.join('\n')).toContain('Unknown provider: unknown-provider');
    }
  });

  it('returns exit code 1 when --model is missing a value', () => {
    for (const argv of [
      ['check', '--model'],
      ['check', '--model='],
      ['check', '--model', '--think'],
    ]) {
      const captured = createCapturedIo();
      const code = runCli(argv, captured.io);

      expect(code).toBe(1);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr.join('\n')).toContain('Missing value for --model');
    }
  });
});
