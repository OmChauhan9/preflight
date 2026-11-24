# Preflight Agent & CLI Setup Guide

Preflight is a standalone, MIT-licensed CLI tool that runs scoped, exit-code-backed CI pre-checks locally before code is committed or pushed. It works directly from your terminal or through a generic Agent Skill (`skills/preflight/SKILL.md`) across Claude Code, Codex, Cursor, OpenClaw, and Antigravity.

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
preflight --help
preflight check
```

If you prefer not to link globally, invoke the CLI via `npx` or directly from the build output:

```bash
npx --no-install preflight check --json
# or inside a built repository checkout:
node dist/cli.js check --json
```

### Core CLI Commands

All four Preflight commands are ready to use out of the box:

- **Run scoped CI pre-checks (JSON for agents or human-readable terminal output):**
  ```bash
  preflight check --json
  preflight check --base origin/main --timeout 60
  ```
- **Explain a CI failure log (local file or GitHub Actions URL) and optionally reproduce locally:**
  ```bash
  preflight explain path/to/ci.log --json
  preflight explain https://github.com/<org>/<repo>/actions/runs/<run-id> --no-verify
  ```
- **Install the optional local git `pre-push` hook:**
  ```bash
  preflight init --hook
  ```
- **Run the curated benchmark suite and write Markdown/JSON reports:**
  ```bash
  preflight bench --out bench/results
  preflight bench --status fail --language ts --limit 5 --json
  ```

### Provider Configuration ($0 Local Default + Free-Tier Cloud Presets)

Preflight talks to any OpenAI-compatible `POST /chat/completions` endpoint and defaults to **local Ollama** (`$0`, no API key required, code stays on your machine):

```bash
ollama pull qwen2.5-coder:7b
preflight check --json
```

When you want faster hosted inference, Preflight also includes built-in presets for free-tier and hosted providers (`groq`, `gemini`, `openrouter`, `cerebras`, `openai`, and `custom`). Set `PREFLIGHT_PROVIDER` and `PREFLIGHT_API_KEY` (or the provider-specific key variable) in a gitignored `.env` file or your shell environment, or pass `--provider <name>` on the command line:

| Provider (`PREFLIGHT_PROVIDER`) | Base URL (`PREFLIGHT_BASE_URL`) | Default Model (`PREFLIGHT_MODEL`) | Provider Key Env Fallback | Requires API Key |
| --- | --- | --- | --- | --- |
| `ollama` *(default)* | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | `OLLAMA_API_KEY` *(optional)* | No ($0 local) |
| `groq` *(free tier)* | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Yes |
| `gemini` *(free tier)* | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | `GEMINI_API_KEY` | Yes |
| `openrouter` *(free tier)* | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-coder-32b-instruct:free` | `OPENROUTER_API_KEY` | Yes |
| `cerebras` *(free tier)* | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | Yes |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` | Yes |
| `custom` | *(required via `PREFLIGHT_BASE_URL`)* | *(required via `PREFLIGHT_MODEL`)* | `PREFLIGHT_API_KEY` *(optional)* | Optional |

Example shell configuration for a free-tier cloud preset:

```bash
export PREFLIGHT_PROVIDER=groq
export PREFLIGHT_API_KEY="<your-groq-api-key>"
preflight check --json
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

Place or symlink `skills/preflight/` into `.cursor/skills/preflight/`, or instruct a Cursor rule in `.cursor/rules/` to follow `skills/preflight/SKILL.md` and run `preflight check --json` before commits:

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

### Post-Edit Agent Loop (`preflight check --json`)

All agents following `skills/preflight/SKILL.md` invoke:

1. `preflight check --json`
2. Fallback: `node dist/cli.js check --json`
3. Fallback: `npx --no-install preflight check --json`

Agents inspect the JSON report and exit code verbatim before committing or pushing:

- **`verdict`**:
  - `passed` (exit `0`): executed allowlisted checks passed (`"these checks passed"`).
  - `no_checks_run` (exit `0`): no changed files or no allowlisted checks were executed (`"no allowlisted checks were executed"`).
  - `failed` (exit `1`): one or more executed allowlisted checks failed or timed out (`"these checks failed"`).
- **`verify.results[]`**: concrete exit-code-backed results for each allowlisted command (`command`, `status`, `exitCode`, `stdout`, `stderr`, `refusalReason`).
- **`think.likely_failures[]`**: ranked predicted failure targets (`category`, `target`, `file`, `line`, `reason`, `confidence`) to narrow down root causes quickly.

Concrete post-edit agent loop example:

```bash
# 1. After editing code, run Preflight in structured JSON mode
preflight check --json > /tmp/preflight-report.json
EXIT_CODE=$?

# 2. Inspect verdict, verify.results[], and think.likely_failures[]
node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync("/tmp/preflight-report.json", "utf8"));

  console.log("Verdict:", report.verdict, "-", report.verdictMessage);

  if (report.verdict === "failed") {
    console.log("Predicted likely failures:");
    for (const item of report.think.likely_failures) {
      const loc = item.file ? `${item.file}${item.line ? `:${item.line}` : ""}` : item.target;
      console.log(`  - [${item.category}] ${loc}: ${item.reason}`);
    }

    console.log("Failed verification commands:");
    for (const res of report.verify.results) {
      if (res.status === "failed" || res.status === "timed_out") {
        console.log(`  - ${res.command} (status=${res.status}, exit=${res.exitCode})`);
        if (res.stderr) console.log(res.stderr);
      }
    }
    process.exit(1);
  }
'

# 3. If EXIT_CODE is non-zero: fix the root cause in code and re-run `preflight check --json`
#    until `verdict` is `passed` (or `no_checks_run`), then commit or push.
```

Agents always report `stdout`, `stderr`, executed/refused commands, and exit codes verbatim, and never claim that remote CI is guaranteed to succeed.

## 3. Optional Git `pre-push` Hook

Install the opt-in local git hook in any repository:

```bash
preflight init --hook
```

This writes an executable `.git/hooks/pre-push` script that runs `preflight check` before every push and aborts on a non-zero exit code.

- Use `preflight init --hook --force` if you explicitly want to replace an existing custom `pre-push` hook.
- Bypass the hook anytime on a single push with `git push --no-verify`.

## 4. Secret Hygiene

- Keep API keys strictly in a gitignored `.env` file or exported shell environment variables (`PREFLIGHT_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`).
- Never commit API keys to git, `skills/preflight/SKILL.md`, agent configuration files, or git hooks.
- Use the default `ollama` provider whenever you want `$0` local execution with zero API keys and zero outbound network calls.
- Verify `.env` remains listed in `.gitignore` before staging changes (`git status`).
