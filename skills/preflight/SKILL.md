---
name: preflight
description: "Run the Preflight CLI stub (preflight check) via exec and display its exact output verbatim (Phase 0)."
version: 0.1.0
allowed-tools: [exec]
metadata:
  openclaw:
    requires:
      bins:
        - preflight
    invocation: "Phase 0 stub: run preflight check (fallback: node dist/cli.js check or npx --no-install preflight check) via exec and show stdout/stderr verbatim. Phase 2 wires post-edit preflight check --json before committing."
---

# Preflight Skill (Phase 0 Stub)

> **Phase 0 Scope Only:** This skill is a minimal CLI stub with zero Gather, Think, Verify, or Explain logic. Currently, `preflight check` prints `not implemented` and exits with code `0`.

## When to Use

Use this skill when asked to run Preflight or verify the Phase 0 OpenClaw-to-CLI stub integration inside a repository.

## Instructions

1. In the target repository directory, run the Preflight CLI stub using the `exec` tool:
   ```bash
   preflight check
   ```
2. If `preflight` is not globally linked or available on `PATH`, fall back in order via `exec`:
   - Built repository checkout:
     ```bash
     node dist/cli.js check
     ```
   - Local npm package binary without network install:
     ```bash
     npx --no-install preflight check
     ```
3. Display the exact `stdout`, `stderr` (if any), and exit code **verbatim**. Do not paraphrase, hide, or fabricate output.

## Phase 2 Roadmap (Not Yet Implemented)

After hackathon kickoff (Phase 2), this skill will be updated so the OpenClaw agent runs `preflight check --json` after making code edits and before committing, then reports exit-code-backed check results and the Cerebras Speed panel without ever claiming that CI will pass.
