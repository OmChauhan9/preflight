---
name: preflight
description: "Run the Preflight CLI (preflight check) to catch likely CI failures locally and display exact command output verbatim."
version: 0.1.0
allowed-tools: [exec]
metadata:
  openclaw:
    requires:
      bins:
        - preflight
---

# Preflight Agent Skill

Preflight is a standalone, open-source CLI that helps coding agents (Claude Code, Codex, Cursor, OpenClaw, Antigravity, and others) catch likely CI failures before code is pushed.

> **Current CLI Status (v0.1.0 Foundation Stub):** `preflight check` is currently a minimal CLI stub that prints `not implemented` and exits with code `0`. Core Gather, Think, and Verify execution ships in the next release.

## When to Use

Use this skill when:

- Asked to run Preflight or verify the Preflight CLI integration in a repository.
- Checking local edits before committing or pushing once the core verification pipeline is enabled.

## Instructions

1. In the target repository directory, run the Preflight CLI via `exec`:
   ```bash
   preflight check
   ```
2. If `preflight` is not globally linked or available on `PATH`, fall back in order via `exec`:
   - Built local repository checkout:
     ```bash
     node dist/cli.js check
     ```
   - Local project installation without downloading from the network:
     ```bash
     npx --no-install preflight check
     ```
3. Display the exact `stdout`, `stderr` (if any), and exit code **verbatim**:
   - Do not paraphrase, truncate, hide, or fabricate output.
   - Never claim that CI will pass; report only the concrete commands executed and their actual exit codes.
4. Preserve secret hygiene:
   - Never hardcode API keys in prompts, configuration files, or repository files, and never echo secrets in output.
   - Preflight defaults to local Ollama (`http://localhost:11434/v1`, no API key required) and loads optional provider keys solely from environment variables or a gitignored `.env` file.

## Planned Post-Edit Workflow

Once the core Gather, Think, and Verify pipeline is implemented, coding agents using this skill should run the following loop after making edits and before committing or pushing:

1. Run structured pre-checks:
   ```bash
   preflight check --json
   ```
2. Inspect the exit-code-backed results returned by scoped repository CI commands (such as lint, typecheck, and targeted tests).
3. If any check exits non-zero, fix the failure and re-run `preflight check --json` before committing or pushing.
4. Report the checked commands and their exit codes factually without claiming that remote CI is guaranteed to pass.
