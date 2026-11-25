---
name: preflight
description: "Run Preflight (preflight check --json) after code edits to catch likely CI failures locally with exit-code-backed verification."
version: 0.1.0
allowed-tools: [exec]
metadata:
  openclaw:
    requires:
      bins:
        - preflight
---

# Preflight Agent Skill

Preflight is a standalone, open-source CLI that helps coding agents (Claude Code, Codex, Cursor, OpenClaw, Antigravity, and others) catch likely CI failures locally before code is committed or pushed.

Preflight runs a four-stage pipeline:
1. **Gather**: collects your git diff against the base ref, `.github/workflows/*.yml` commands, and affected tests (via the static import graph) within a strict token budget.
2. **Think**: calls any OpenAI-compatible LLM (defaulting to local Ollama at `http://localhost:11434/v1` with `$0` cost and no API key required) to predict likely failures and select scoped CI commands.
3. **Verify**: executes only commands allowlisted by repository CI workflows using `shell: false`, refusing any non-CI command without executing it.
4. **Telemetry**: reports provider, token usage, throughput (`tok/s`), and per-stage wall-clock timing on every run.

## When to Use

Use this skill when:

- You have made code edits and want to run scoped CI pre-checks before committing or pushing.
- Asked to run Preflight, explain a CI failure log, or install the optional git `pre-push` hook.

## Post-Edit Workflow

Run this loop after making edits and before committing or pushing:

1. In the target repository directory, run structured pre-checks via `exec`:
   ```bash
   preflight check --json
   ```
   (Use `preflight check` for human-readable terminal output with the Speed & Telemetry panel.)
2. If `preflight` is not globally linked or available on `PATH`, fall back in order via `exec`:
   - Built local repository checkout:
     ```bash
     node dist/cli.js check --json
     ```
     (or `node dist/cli.js check`)
   - Local project installation without downloading from the network:
     ```bash
     npx --no-install preflight check --json
     ```
     (or `npx --no-install preflight check`)
3. Interpret the structured output and exit code factually:
   - Exit code `0`: executed allowlisted checks passed (`"these checks passed"`) or no allowlisted checks needed to run (`"no allowlisted checks were executed"`).
   - Exit code `1`: at least one executed allowlisted check failed or timed out (`"these checks failed"`), or a CLI error occurred.
4. If any check exits non-zero, inspect the failing command's `stdout`/`stderr`, fix the root cause in code, and re-run `preflight check --json` before committing or pushing.
5. Display `stdout`, `stderr` (if any), and the exit code **verbatim**:
   - Do not paraphrase, truncate, hide, or fabricate output.
   - Report only the concrete commands executed, any refused commands, and their actual exit codes.
   - Never claim that remote CI is guaranteed to succeed.

## Additional Commands

- Explain a failing CI log (local file or GitHub Actions URL) and optionally reproduce the allowlisted command locally:
  ```bash
  preflight explain <log-url-or-file> --json
  ```
- Install the optional local git `pre-push` hook (bypassable anytime with `git push --no-verify`):
  ```bash
  preflight init --hook
  ```

## Secret Hygiene

- Never hardcode API keys in prompts, configuration files, or repository files, and never echo secrets in output.
- Preflight defaults to local Ollama (`http://localhost:11434/v1`, no API key required) and loads optional cloud provider keys solely from environment variables or a gitignored `.env` file.
