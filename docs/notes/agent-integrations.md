# Coding Agent & Git Hook Integrations (`docs/notes/agent-integrations.md`)

This document provides source-verified reference notes on the open **Agent Skills (`SKILL.md`)** specification, discovery paths across major AI coding agents (**Claude Code**, **OpenAI Codex**, **Cursor**, **OpenClaw**, and **Antigravity**), Preflight's machine-readable `--json` CLI contract, and Git's `pre-push` hook mechanism.

---

## 1. The Open Agent Skills Specification (`SKILL.md`)

Preflight packages its agent integration as a portable skill folder at [`skills/preflight/SKILL.md`](../../skills/preflight/SKILL.md) conforming to the open **Agent Skills** standard.

- **Specification Home & Schema:**
  - *Sources:* [Agent Skills Overview (`agentskills.io`)](https://agentskills.io/home), [Agent Skills Format Specification (`agentskills.io/specification`)](https://agentskills.io/specification)
- **Directory Layout:**
  ```text
  skills/preflight/
  └── SKILL.md    # Required: YAML frontmatter (name, description) + Markdown instructions
  ```
- **Required YAML Frontmatter Fields:**
  - `name`: Lowercase alphanumeric identifier with hyphens (`preflight`), max 64 characters, matching the skill directory name.
  - `description`: Clear statement of what the skill does and *when* the agent should activate it (max 1024 characters).
  - Optional standard fields: `license`, `compatibility`, `metadata`, `allowed-tools`.
  - *Source:* [Agent Skills Format Specification](https://agentskills.io/specification)
- **Three-Phase Progressive Disclosure:**
  1. **Discovery:** At session startup, the coding agent scans configured skill directories and loads only the compact `name` and `description` frontmatter into system context.
  2. **Activation:** When the user's task involves running pre-push checks, opening a PR, or diagnosing a CI failure (or when the user invokes `/preflight`), the agent reads the full `SKILL.md` body.
  3. **Execution:** The agent runs `preflight check --json` or `preflight explain <log> --json` via its shell tool and acts on the structured JSON result and exit code.
  - *Source:* [Agent Skills Overview — How Skills Work](https://agentskills.io/home)

---

## 2. Discovery Paths Across Supported Coding Agents

Because `skills/preflight/SKILL.md` uses standard frontmatter and invokes the standalone `preflight` CLI, the exact same folder works across five major AI coding agents. See [`docs/agent-setup.md`](../agent-setup.md) for copy/symlink commands.

### 2.1 Claude Code

- **Skill Locations:**
  - Project-scoped: `.claude/skills/preflight/SKILL.md`
  - User-scoped (global): `~/.claude/skills/preflight/SKILL.md`
- **Invocation Behavior:**
  - Exposes `/preflight` as a slash command and allows Claude Code to invoke the skill autonomously when matching the frontmatter `description` (unless `disable-model-invocation: true` is set).
- **Sources:**
  - [Claude Code Skills Documentation (`code.claude.com/docs/en/skills`)](https://code.claude.com/docs/en/skills)
  - [Anthropic Claude Code Documentation](https://docs.anthropic.com/en/docs/claude-code/skills)

### 2.2 OpenAI Codex CLI & Agent

- **Skill Locations:**
  - Project-scoped: `.codex/skills/preflight/SKILL.md` or `.agents/skills/preflight/SKILL.md`
  - User-scoped (global): `~/.codex/skills/preflight/SKILL.md` or `~/.agents/skills/preflight/SKILL.md`
- **Invocation Behavior:**
  - Codex discovers `SKILL.md` definitions in `.codex/skills/` and `.agents/skills/` alongside repository `AGENTS.md` instructions.
- **Sources:**
  - [OpenAI Codex CLI Repository (`github.com/openai/codex`)](https://github.com/openai/codex)
  - [Agent Skills Specification (`agentskills.io`)](https://agentskills.io/home)

### 2.3 Cursor

- **Skill Locations:**
  - Project-scoped: `.cursor/skills/preflight/SKILL.md` or `.agents/skills/preflight/SKILL.md`
  - Compatibility fallback paths also scanned by Cursor: `.claude/skills/` and `.codex/skills/`
- **Invocation Behavior:**
  - Cursor's agent mode loads `SKILL.md` frontmatter from configured skill folders and triggers the workflow before `git push` or PR creation.
- **Sources:**
  - [Cursor Agent Skills Documentation (`cursor.com/docs/context/skills`)](https://cursor.com/docs/context/skills)
  - [Cursor Rules & Context Documentation (`docs.cursor.com/context/rules`)](https://docs.cursor.com/context/rules)

### 2.4 OpenClaw

- **Skill Locations:**
  - Workspace-scoped: `<workspace>/skills/preflight/SKILL.md`
  - User-scoped (global): `~/.openclaw/skills/preflight/SKILL.md`
- **Invocation Behavior:**
  - OpenClaw scans `<workspace>/skills/` and `~/.openclaw/skills/` for `SKILL.md` definitions and executes `preflight check --json` through its built-in shell execution tool.
- **Sources:**
  - [OpenClaw Skills Documentation (`docs.openclaw.ai/tools/skills`)](https://docs.openclaw.ai/tools/skills)

### 2.5 Google Antigravity (AGY) & Other `SKILL.md`-Compatible Harnesses

- **Skill File Format:**
  - Consumes the standard `SKILL.md` YAML frontmatter (`name`, `description`) and Markdown instructions defined by the open Agent Skills specification.
  - *Source (SKILL.md format only):* [Agent Skills Format Specification (`agentskills.io/specification`)](https://agentskills.io/specification)
- **Skill Discovery Paths (Harness-Configuration Dependent):**
  - Unlike `agentskills.io` (which standardizes the `SKILL.md` file format rather than mandating a single host-tool directory path), local discovery directories depend on the specific harness version and user/workspace configuration (commonly `.agent/skills/preflight/SKILL.md`, `.agents/skills/preflight/SKILL.md`, or the user's configured skills directory; see [`docs/agent-setup.md`](../agent-setup.md)).

---

## 3. Universal CLI `--json` Contract & Direct Shell Fallback

Per [ADR-004](../DECISIONS.md#adr-004-generic-agent-skill-skillspreflightskillmd--optional-git-pre-push-hook), any coding agent — even one without `SKILL.md` discovery — can invoke Preflight directly via its shell tool (falling back in order from `preflight` to `npx --no-install preflight`, or `node dist/cli.js` inside a local Preflight repository checkout, when not globally linked):

```bash
# Pre-push verification
preflight check --json

# Post-failure CI log diagnosis
preflight explain <ci-log-url-or-path> --json
```

### Agent Decision Rules on `preflight check --json` Output

1. **Verdict Authority:** The agent must inspect the top-level `verdict` (`'passed' | 'failed' | 'no_checks_run'`), `verdictMessage` (`'these checks passed' | 'these checks failed' | 'no allowlisted checks were executed'`), each item in `verify.results[]` (`command`, `status`, `exitCode`, `durationMs`, `stdout`, `stderr`, and optional `matchedWorkflowCommand` / `refusalReason`), and `verify.refusedCommands[]` (`command`, `reason`).
2. **Exit Codes:**
   - Process exit code `0`: Either `verdict` is `'passed'` (all executed allowlisted commands exited with `0`) or `verdict` is `'no_checks_run'` (no repository changes were detected or no allowlisted commands could be executed). The agent may proceed with `git push` or PR creation while reporting verbatim which scoped checks passed — or explicitly stating when `no_checks_run` occurred.
   - Process exit code `1`: `verdict` is `'failed'` (one or more executed allowlisted commands exited non-zero or timed out) or a CLI/validation/network error occurred. The agent must inspect the failing command output, fix the defect, and re-run `preflight check --json` before pushing.
3. **Invariant Enforcement:** Neither Preflight nor the calling agent may claim `"CI will pass"` — only that the listed allowlisted checks passed, failed, or were not run locally.

---

## 4. Optional Git `pre-push` Hook (`preflight init --hook`)

In addition to agent skills, Preflight provides the `preflight init --hook` command (supporting `--force` to replace an existing custom hook and `--json` for structured output), which installs an executable Preflight-managed Git `pre-push` hook at `.git/hooks/pre-push` (resolving `.git` directories as well as `gitdir:`/`commondir` pointers in linked worktrees and submodules).

### How Git Invokes `.git/hooks/pre-push`

According to the official Git documentation:

- **Trigger Point:** Invoked by `git push` after remote refs have been checked and before any objects are transferred to the remote repository.
- **Command-Line Arguments:**
  - `$1`: The name of the remote destination (e.g., `origin`), or the URL if no named remote is used.
  - `$2`: The URL to which the push is being made.
- **Standard Input (`stdin`):**
  - Receives one line per ref being pushed in the exact format:
    ```text
    <local-ref> SP <local-object-name> SP <remote-ref> SP <remote-object-name> LF
    ```
  - When a new branch is pushed for the first time, `<remote-object-name>` is the 40-zero SHA (`0000000000000000000000000000000000000000`). When a remote ref is being deleted, `<local-ref>` is `(delete)` and `<local-object-name>` is all zeroes.
- **Exit Code Contract:**
  - If `.git/hooks/pre-push` exits with `0`, `git push` proceeds.
  - If `.git/hooks/pre-push` exits with a non-zero status, `git push` immediately aborts before transferring any commits.
  - Developers can bypass the hook explicitly in emergencies using `git push --no-verify`.
- **Source:** [Official Git `githooks` Documentation — `pre-push` (`git-scm.com/docs/githooks#_pre_push`)](https://git-scm.com/docs/githooks#_pre_push)
