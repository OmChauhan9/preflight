# Preflight Agent & CLI Setup Guide

Preflight is a standalone, MIT-licensed CLI tool that works directly from your terminal or through a generic Agent Skill (`skills/preflight/SKILL.md`) across Claude Code, Codex, Cursor, OpenClaw, and Antigravity.

> **Current Foundation Status:** In v0.1.0, `preflight check` is a CLI stub that prints `not implemented` and exits with code `0`. Core Gather, Think, and Verify execution lands in the next release.

## 1. Standalone CLI Setup

### Prerequisites

- **Node.js `>=22`**
- *(Recommended for $0 local runs)* **Ollama** running locally at `http://localhost:11434`

### Build and Install

From a local checkout of this repository:

```bash
npm install
npm run build
npm link
```

Verify the CLI is on your `PATH`:

```bash
preflight check
```

If you prefer not to link globally, invoke the CLI via `npx` or directly from the build output:

```bash
npx preflight check
# or inside a built repository checkout:
node dist/cli.js check
```

### Provider Configuration ($0 Local Default + Cloud Presets)

Preflight talks to any OpenAI-compatible `POST /chat/completions` endpoint and defaults to **local Ollama** (`$0`, no API key required, code stays on your machine):

```bash
ollama pull qwen2.5-coder:7b
preflight check
```

To switch providers, set `PREFLIGHT_PROVIDER` and `PREFLIGHT_API_KEY` (or the provider-specific API key variable) in a local `.env` file or your shell environment, or pass `--provider <name>` on the command line:

| Provider (`PREFLIGHT_PROVIDER`) | Base URL (`PREFLIGHT_BASE_URL`) | Default Model (`PREFLIGHT_MODEL`) | Provider Key Env Fallback | Requires API Key |
| --- | --- | --- | --- | --- |
| `ollama` *(default)* | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | `OLLAMA_API_KEY` *(optional)* | No ($0 local) |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Yes |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | `GEMINI_API_KEY` | Yes |
| `openrouter` | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-coder-32b-instruct:free` | `OPENROUTER_API_KEY` | Yes |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` | Yes |
| `cerebras` | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | Yes |
| `custom` | *(required via `PREFLIGHT_BASE_URL`)* | *(required via `PREFLIGHT_MODEL`)* | `PREFLIGHT_API_KEY` *(optional)* | Optional |

Example shell configuration for a cloud preset:

```bash
export PREFLIGHT_PROVIDER=groq
export PREFLIGHT_API_KEY="<your-groq-api-key>"
preflight check
```

Or using a local `.env` file copied from `.env.example`:

```bash
cp .env.example .env
# Edit .env locally (never commit it)
```

## 2. Generic Agent Skill (`skills/preflight/SKILL.md`)

`skills/preflight/SKILL.md` uses standard YAML frontmatter (`name: preflight`, `description`, `version`, `allowed-tools: [exec]`) and optional OpenClaw metadata (`metadata.openclaw.requires.bins: [preflight]`), so the same skill works across multiple coding agents without locking into any single platform.

### Claude Code

Copy or symlink `skills/preflight/` into your project or user skills directory:

```bash
# Project-scoped
mkdir -p .claude/skills
ln -s "$(pwd)/skills/preflight" .claude/skills/preflight

# Or user-scoped
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/preflight" ~/.claude/skills/preflight
```

### Codex

Copy or symlink `skills/preflight/` into `.agents/skills/preflight/` (project-scoped) or `~/.agents/skills/preflight/` (user-scoped), or reference `skills/preflight/SKILL.md` from your repository `AGENTS.md`:

```bash
mkdir -p .agents/skills
ln -s "$(pwd)/skills/preflight" .agents/skills/preflight
```

### Cursor

Place or symlink `skills/preflight/` into `.cursor/skills/preflight/`, or instruct a Cursor rule in `.cursor/rules/` to follow `skills/preflight/SKILL.md` and run `preflight check` before commits:

```bash
mkdir -p .cursor/skills
ln -s "$(pwd)/skills/preflight" .cursor/skills/preflight
```

### OpenClaw

Install or symlink `skills/preflight/` into your OpenClaw workspace `skills/` directory (or `~/.openclaw/skills/preflight/`). Because `skills/preflight/SKILL.md` declares `metadata.openclaw.requires.bins: [preflight]`, OpenClaw automatically checks whether `preflight` is available on `PATH`.

Verify skill readiness with:

```bash
openclaw skills info preflight
```

### Antigravity

Copy or symlink `skills/preflight/` into your workspace or user skills directory (for example `.agent/skills/preflight/`) and invoke the `preflight` skill before committing or pushing changes.

### What Every Agent Runs

All agents following `skills/preflight/SKILL.md` invoke:

1. `preflight check`
2. Fallback: `node dist/cli.js check`
3. Fallback: `npx --no-install preflight check`

Agents display `stdout`, `stderr`, and the exit code verbatim. Once the core pipeline ships, agents will run `preflight check --json` after code edits and before committing or pushing.

## 3. Planned Optional Git `pre-push` Hook (Phase 1)

An optional local git hook installer is planned for Phase 1:

```bash
# Planned in Phase 1 (not yet implemented)
preflight init --hook
```

When implemented, `preflight init --hook` will install an opt-in `.git/hooks/pre-push` script that runs `preflight check` before every push and aborts on a non-zero exit code (bypassable anytime with `git push --no-verify`).

## 4. Secret Hygiene

- Keep API keys strictly in a gitignored `.env` file or exported shell environment variables (`PREFLIGHT_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`).
- Never commit API keys to git, `skills/preflight/SKILL.md`, agent configuration files, or git hooks.
- Use the default `ollama` provider whenever you want `$0` local execution with zero API keys and zero outbound network calls.
- Verify `.env` remains listed in `.gitignore` before staging changes (`git status`).
