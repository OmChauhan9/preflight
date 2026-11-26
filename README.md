# Preflight

**Local-first, $0 CI pre-checks and failure diagnosis for developers and AI coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Default Provider: Ollama ($0 Local)](https://img.shields.io/badge/default%20LLM-Ollama%20(%240%20local)-orange.svg)](https://ollama.com/)

AI coding agents and developers iterate in seconds, push a branch or open a pull request, and then wait minutes for GitHub Actions to fail on a scoped unit test, typecheck, or lint rule broken by their diff. Running the entire CI suite locally after every edit is too slow; skipping checks entirely produces broken PRs.

**Preflight** closes that loop in seconds at **$0 cost**. Before you or your agent pushes code, Preflight inspects your local `git diff`, static import graph, and `.github/workflows/*.yml` definitions, asks an OpenAI-compatible LLM (defaulting to local **Ollama** with `qwen2.5-coder:7b`) which CI jobs and scoped commands are affected, executes only those workflow-derived commands locally with `shell: false`, and reports the real subprocess exit codes and speed telemetry. When remote CI has already failed, `preflight explain` diagnoses the failure log against your diff, proposes a minimal patch, and optionally reproduces the allowlisted command locally.

---

## Core Trust Invariant

> **An LLM decides *what* to check from your `git diff`, import graph, and `.github/workflows/*.yml`; real allowlisted scoped CI commands decide pass or fail via actual subprocess exit codes. Preflight never claims "CI will pass" — only "these checks passed" or "these checks failed".**

- **LLM for triage & diagnosis only:** The model maps a diff and workflow definition to the highest-signal subset of checks, or diagnoses a failure log.
- **Strict workflow-derived allowlist (`shell: false`):** Every command proposed by the model must match a tool and subcommand already defined in `.github/workflows/*.yml` (only narrowing scope to safe repository-relative file paths or test filters). Unapproved binaries, shell chaining, redirection, dangerous flags, or path traversal are refused without execution and logged.
- **100% exit-code-driven verdicts:** Every pass/fail result maps 1:1 to a real subprocess exit code executed in your working tree — or fails closed with `no_checks_run` (`"no allowlisted checks were executed"`) when no valid CI workflow commands exist.

---

## How It Works (`Gather → Think → Verify` + `Explain`)

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. GATHER (Plain Code — Deterministic, 0 Tokens)                        │
│    • git diff vs base ref & changed file paths                          │
│    • Static import graph (JS/TS & Python) → transitively affected tests │
│    • Parsed .github/workflows/*.yml jobs & canonical run commands       │
│    • Deterministic 5-tier priority trimming to <= 20,000 estimated      │
│      context tokens (chars / 4, ~20K prompt tokens):                    │
│      (1) git diff (+ optional recent_ci_log) → (2) CI commands →        │
│      (3) changed files' tests → (4) changed files → (5) neighbors       │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. THINK (Single LLM Call via OpenAICompatibleClient)                   │
│    • Default: local Ollama (qwen2.5-coder:7b, $0, no API key needed)    │
│    • Or any preset: groq, gemini, openrouter, openai, cerebras, custom  │
│    • Input: <= 20,000 est. context tokens (~20K) | max_completion: 1,500│
│    • Reasoning: off by default (opt-in via --think)                     │
│    • Plain-text JSON contract validated against schema + at most 1 retry│
│      { likely_failures[], affected_jobs[], commands[], notes }          │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. VERIFY (Plain Code — Safe Subprocess Execution, shell: false)        │
│    • Enforce workflow-derived command allowlist (same tool + subcommand,│
│      narrower safe paths / test filters only)                           │
│    • Refuse & log any unapproved command, flag, or shell metacharacter  │
│    • Run approved commands with per-command timeouts (default 60s)      │
│    • Verdict from real exit codes ("these checks passed / failed" or    │
│      fail-closed "no allowlisted checks were executed")                 │
│    • Render Speed & Telemetry Panel (tokens, tok/s, stage wall times)   │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ 4. EXPLAIN (preflight explain <CI log URL or file>)                     │
│    • Read failing CI log (local file or GitHub Actions URL) + local diff│
│    • Single LLM call → root_cause + failing_command + suggested_patch   │
│      + explanation                                                      │
│    • Re-run allowlisted failing command locally unless --no-verify      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## $0 Local-First Default & Supported Providers

Preflight uses a single provider-agnostic `OpenAICompatibleClient` (`POST {baseUrl}/chat/completions`). By default it connects to **local Ollama** (`http://localhost:11434/v1`) with **`qwen2.5-coder:7b`**, requiring **no API key and $0** to run. Switch providers at any time via `--provider <preset>`, `PREFLIGHT_PROVIDER`, `~/.config/preflight/.env`, or an explicit `--env-file <path>`.

| Preset (`--provider`) | Default Base URL | Default Model (`--model`) | Auth Env Var | Cost / Tier Notes |
| :--- | :--- | :--- | :--- | :--- |
| **`ollama`** *(default)* | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | `OLLAMA_API_KEY` *(optional)* | **$0 local-first** on your machine via [Ollama](https://ollama.com/) |
| **`groq`** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Cloud LPU inference (provider free tier subject to change) |
| **`gemini`** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` | Google AI Studio API (provider free tier subject to change) |
| **`openrouter`** | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-coder-32b-instruct:free` | `OPENROUTER_API_KEY` | OpenRouter catalog (`:free` model availability subject to change) |
| **`openai`** | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` | Standard OpenAI pay-as-you-go API |
| **`cerebras`** | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | Wafer-scale inference with server `time_info` telemetry |
| **`custom`** | `PREFLIGHT_BASE_URL` *(required)* | `PREFLIGHT_MODEL` *(required)* | `PREFLIGHT_API_KEY` *(optional)* | Any OpenAI-compatible server (vLLM, LM Studio, llama.cpp, LiteLLM) |

Configuration precedence: CLI flags (`--provider`, `--model`, `--env-file`) → generic env vars (`PREFLIGHT_PROVIDER`, `PREFLIGHT_MODEL`, `PREFLIGHT_BASE_URL`, `PREFLIGHT_API_KEY`) → provider-specific env vars (`OLLAMA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, used only with the preset's default base URL) → built-in preset defaults (`ollama`). See [`docs/notes/providers.md`](./docs/notes/providers.md) for source-verified endpoint documentation, rate-limit behavior, and payload details.

---

## Quickstart & CLI Reference

### 1. Prerequisites & Installation

- **Node.js `>=22`** and **Git**
- *(Optional)* **GitHub CLI (`gh`)** — required when passing a GitHub Actions run/job URL to `preflight explain <GitHub Actions URL>`
- For the default **$0 local workflow**, install [Ollama](https://ollama.com/), ensure Ollama is running (`ollama serve` or the Ollama desktop app), and pull the default coding model:

```bash
ollama serve                # or launch the Ollama desktop app
ollama pull qwen2.5-coder:7b
```

Clone, build, and link Preflight:

```bash
git clone https://github.com/OmChauhan9/preflight.git
cd preflight
npm install
npm run build
npm link
```

Verify the CLI is available:

```bash
preflight --help
```

If you prefer not to link globally with `npm link`, invoke Preflight via `npx` or directly from the built checkout:

```bash
# inside a repository with preflight installed locally:
npx --no-install preflight --help
# or inside the Preflight repository checkout itself
# (from another repo, pass node /path/to/preflight/dist/cli.js --help):
node dist/cli.js --help
```

### 2. Commands & Usage Examples

All four CLI commands are live in `v0.1.0`:

```bash
# 1. Run scoped CI pre-checks on your working tree diff (local Ollama by default)
preflight check
preflight check --json
preflight check --base origin/main --timeout 60
preflight check --log ./ci-failure.log --json
preflight check --env-file ~/.config/preflight/.env
GROQ_API_KEY=... preflight check --provider groq
GEMINI_API_KEY=... preflight check --provider gemini
OPENROUTER_API_KEY=... preflight check --provider openrouter
preflight check --provider ollama --model qwen2.5-coder:14b --think

# 2. Explain a CI failure log (local file or GitHub Actions run/job URL)
preflight explain ./ci-failure.log
preflight explain ./ci-failure.log --json
preflight explain https://github.com/owner/repo/actions/runs/123456789
preflight explain ./ci-failure.log --base origin/main --timeout 60 --no-verify

# 3. Install the optional local git pre-push hook
preflight init --hook
preflight init --hook --force          # overwrite an existing custom pre-push hook
preflight init --hook --json

# 4. Run the curated benchmark triage suite and emit metrics
preflight bench --provider ollama --out bench/results
preflight bench --status fail --language typescript --limit 5 --json
preflight bench --case fail-01-express-pr-7531 --cases-dir bench/cases
```

### 3. CLI Options Reference

| Option | Commands | Description |
| :--- | :--- | :--- |
| `--provider <preset>` | `check`, `explain`, `bench` | LLM provider preset: `ollama` *(default)*, `groq`, `gemini`, `openrouter`, `openai`, `cerebras`, `custom` |
| `--model <name>` | `check`, `explain`, `bench` | Override the provider model name |
| `--env-file <path>` | all commands | Load environment variables from an explicit `.env` file (Preflight auto-loads `~/.config/preflight/.env`, not repo-local `.env`) |
| `--base <ref>` | `check`, `explain` | Git base ref to diff against *(default: auto-detect)* |
| `--log <file>` | `check` | Attach a recent CI failure log file to check context |
| `--timeout <seconds>` | `check`, `explain` | Per-command verification timeout in seconds *(default: `60`)* |
| `--no-verify` | `explain` | Skip local reproduction check during `explain` |
| `--hook` | `init` | Install the git `pre-push` hook *(required for `preflight init --hook`)* |
| `--force` | `init` | Overwrite an existing custom `pre-push` hook |
| `--cases-dir <dir>` | `bench` | Benchmark cases directory *(default: `bench/cases`)* |
| `--case <id>` | `bench` | Run a single benchmark case by ID |
| `--status <fail\|pass\|all>` | `bench` | Filter benchmark cases by status *(default: `all`)* |
| `--language <lang>` | `bench` | Filter benchmark cases by language (`javascript`, `typescript`, `python`) |
| `--limit <n>` | `bench` | Limit the number of benchmark cases to run |
| `--out <dir>` | `bench` | Write `summary.md` and `results.json` to directory |
| `--json` | all commands | Emit machine-readable, secret-redacted JSON output |
| `--think` | `check`, `explain`, `bench` | Enable model reasoning mode (`reasoning_effort: "low"`; `reasoning_format: "parsed"` sent only to `groq`/`cerebras`) |
| `-h`, `--help` | global | Show CLI usage and available options |

---

## JSON Output & Speed Telemetry

Passing `--json` emits a secret-redacted JSON payload tailored for AI coding agents and automation:

- **Top-level `preflight check --json` fields:** `verdict` (`"passed"` | `"failed"` | `"no_checks_run"`), `verdictMessage` (`"these checks passed"` | `"these checks failed"` | `"no allowlisted checks were executed"`), `baseRef`, `changedFiles[]`, `gather`, `think`, `thinkAttempts`, `verify`, and `telemetry`.
- **Verification details (`verify`):**
  - `verify.results[]`: Each entry contains `command`, `status` (`"passed"` | `"failed"` | `"timed_out"` | `"refused"`), `exitCode` (`number | null`), `durationMs`, `stdout`, `stderr`, plus optional `matchedWorkflowCommand` or `refusalReason`.
  - `verify.refusedCommands[]`: Array of `{ command, reason }` for every command rejected by the workflow allowlist.
- **Speed & Telemetry (`telemetry`):** Records `provider`, `model`, `base_url` (sanitized), `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`), `tok_per_s` and `tok_per_s_source` (`"time_info"` | `"wall_time"` | `null`), optional provider `time_info`, and stage wall times in `timing_ms` (`gather_ms`, `think_ms`, `verify_ms`, `total_wall_ms`). In human-readable mode, every `check` and `explain` run renders the equivalent **Speed & Telemetry** panel.
- **Exit codes:**
  - `preflight check`: exits `0` for `passed` or `no_checks_run`; exits `1` for `failed` or CLI/validation/runtime errors.
  - `preflight explain`: exits `0` on valid diagnosis output; exits `1` on CLI, log-loading, validation, or runtime errors.
  - `preflight init --hook`: exits `0` on `installed`, `updated`, or `already_installed`; exits `1` if not inside a git repo or if a custom `pre-push` hook exists without `--force`.
  - `preflight bench`: exits `0` when `metrics.errors === 0`; exits `1` when any benchmark case errors or a CLI error occurs.

*Illustrative `preflight check --json` format example (schema illustration only — not a live benchmark run):*

```json
{
  "verdict": "passed",
  "verdictMessage": "these checks passed",
  "baseRef": "origin/main",
  "changedFiles": ["src/clients/http.ts"],
  "gather": {
    "estimatedTokens": 1840,
    "truncatedSections": [],
    "workflowCommandCount": 3,
    "affectedTestCount": 1
  },
  "think": {
    "likely_failures": [
      {
        "category": "test",
        "target": "test/client.test.ts",
        "reason": "Diff modifies HTTP retry backoff logic imported by test/client.test.ts"
      }
    ],
    "affected_jobs": ["test", "typecheck"],
    "commands": ["npx vitest run test/client.test.ts", "npm run typecheck"],
    "notes": "Scoped unit test and typecheck derived from CI workflow."
  },
  "thinkAttempts": 1,
  "verify": {
    "verdict": "passed",
    "verdictMessage": "these checks passed",
    "results": [
      {
        "command": "npx vitest run test/client.test.ts",
        "status": "passed",
        "exitCode": 0,
        "durationMs": 420,
        "stdout": "...",
        "stderr": "",
        "matchedWorkflowCommand": "npx vitest run"
      }
    ],
    "refusedCommands": [],
    "durationMs": 420
  },
  "telemetry": {
    "provider": "ollama",
    "model": "qwen2.5-coder:7b",
    "base_url": "http://localhost:11434/v1",
    "usage": { "prompt_tokens": 1840, "completion_tokens": 128, "total_tokens": 1968 },
    "tok_per_s": 58.2,
    "tok_per_s_source": "wall_time",
    "time_info": null,
    "timing_ms": { "gather_ms": 42, "think_ms": 2200, "verify_ms": 420, "total_wall_ms": 2662 }
  }
}
```

---

## Security & Hardening

Preflight treats LLM output, repository diffs, and CI logs as untrusted input:

- **Workflow-derived allowlist with `shell: false`:** Commands are tokenized without a shell and executed via `child_process.spawn(binary, args, { shell: false })` only after matching a canonical tool + subcommand parsed from `.github/workflows/*.yml`. Unmodeled tools and runners default to **exact-match-only**, and shell builtins such as `cd` are dropped.
- **Metacharacter, chaining, redirection, argfile & path-traversal blocking:** Refuses `;`, `&&`, `||`, `|`, `` ` ``, `$(...)`, `${...}`, `>`, `<`, newlines/NUL bytes, inline `KEY=VAL` env assignments, `@args.txt` argfiles, and `..` path traversal — including URI schemes (`file:`, `http://`, etc.), colon/pytest-node external paths, Windows drive letters, comma-delimited arguments, and multi-equals payloads.
- **Verbatim baseline flags & binary/target-swap prevention:** Every flag inherited from the matched baseline CI command is **preserved verbatim** (preventing flag stripping such as dropping `--check` or `--strict`); weakening/dangerous flags (such as `--eval`, `--require`, `--config`, `--fix`, `--write`, `--updateSnapshot`, `--exit-zero`) are blocked unless verbatim in CI; Python interpreter binary path swaps (e.g., `/tmp/evil/python -m pytest`) are blocked; and interpreters (`node`, `python`, `sh`, `bash`, etc.), package-manager mutation subcommands, and task runners (`make`, `just`, `rake`, `git`, `curl`, `docker`, etc.) require exact workflow matches.
- **Env isolation & exfiltration defense:** Repo-local `.env` files in the analyzed repository are **not** auto-loaded (opt in explicitly via `--env-file <path>` or store keys in `~/.config/preflight/.env`); custom `PREFLIGHT_BASE_URL` overrides never silently pair with a preset's provider-specific key (requiring explicit `PREFLIGHT_API_KEY`); and child CI verification subprocesses have LLM API key environment variables stripped before spawn.
- **Hardened Gather & fail-closed Verify:** Gather diffs against `git merge-base` and blocks symlinks resolving outside the repository root. If `.github/workflows/*.yml` yields no valid CI commands, every proposed command is refused and `Verify` returns `verdict: "no_checks_run"` (`"no allowlisted checks were executed"`) rather than running unverified commands or reporting a false pass.
- **Secret redaction & rate-limit resilience:** Configured API keys, `Bearer` tokens, `Authorization` headers, and sensitive URL query parameters are scrubbed to `[REDACTED]` across terminal reports, `--json` output, `--out` benchmark artifacts, and errors. `OpenAICompatibleClient` enforces a process-wide single-flight FIFO queue (`concurrency = 1`) and honors HTTP `429` `Retry-After` headers (delta-seconds or HTTP-date / ISO-8601) with bounded jittered exponential backoff.
- **Adversarially verified test suite:** Protected by an extensive Vitest unit and adversarial security test suite across 12 test files, including dedicated allowlist, gather, env-isolation, redaction, and injection tests in `test/adversarial.test.ts`.

---

## AI Coding Agent Skill & Git Hook

### Portable Agent Skill (`skills/preflight/SKILL.md`)

Preflight ships with a portable [Agent Skills](https://agentskills.io) definition at [`skills/preflight/SKILL.md`](./skills/preflight/SKILL.md) that instructs coding agents to run `preflight check --json` (with fallbacks to `npx --no-install preflight check --json` and, inside a Preflight checkout, `node dist/cli.js check --json`) after edits and act on verbatim exit-code-backed results before committing or pushing:

- **Claude Code:** Copy or symlink `skills/preflight` to `.claude/skills/preflight`
- **OpenAI Codex:** Copy or symlink `skills/preflight` to `.codex/skills/preflight` (or `.agents/skills/preflight`)
- **Cursor:** Copy or symlink `skills/preflight` to `.cursor/skills/preflight` (or `.agents/skills/preflight`)
- **OpenClaw:** Copy or symlink `skills/preflight` to `<workspace>/skills/preflight` (or `~/.openclaw/skills/preflight`)
- **Antigravity:** Copy or symlink `skills/preflight` to `.agent/skills/preflight`

### Optional Git `pre-push` Hook (`preflight init --hook`)

For automatic enforcement on every `git push` — in standard repositories, git worktrees, and submodules — run:

```bash
preflight init --hook
```

This installs a Preflight-managed executable `.git/hooks/pre-push` script that runs `preflight check` (falling back to a local `./node_modules/.bin/preflight` install) and aborts pushes on non-zero exit codes. Existing custom hooks are protected unless you pass `--force`, and any push can be bypassed explicitly with `git push --no-verify`.

See [`docs/agent-setup.md`](./docs/agent-setup.md) and [`docs/notes/agent-integrations.md`](./docs/notes/agent-integrations.md) for full per-agent installation steps and `--json` decision rules.

---

## Verified Benchmark Corpus (`bench/`)

Preflight includes a curated, hand-verified benchmark corpus of **35 real public GitHub Pull Request CI runs** in `bench/cases/*.json` across **10 open-source JavaScript/TypeScript and Python repositories**:

- **25 Failed-CI PRs (`fail-01` .. `fail-25`):** 13 unit test failures (`unit_test`), 5 typecheck failures (`typecheck`), and 7 lint/format failures (`lint_format`). Every case is dual-verified against both the verbatim GitHub Actions failure log and the exact commit diff (`base_sha..head_sha`) to confirm the failure was caused directly by the PR's code changes.
- **10 Passing-CI PRs (`pass-01` .. `pass-10`):** Clean passing PRs from the same 10 repositories (`expressjs/express`, `colinhacks/zod`, `unjs/h3`, `fastify/fastify`, `axios/axios`, `pallets/werkzeug`, `pallets/jinja`, `pallets/click`, `encode/httpx`, `pydantic/pydantic-settings`) to evaluate false-alarm rate and check scoping precision.
- **2 Local `<1s` Anchor Reproductions:** Documented end-to-end in [`bench/REPRO.md`](./bench/REPRO.md):
  - `fail-01-express-pr-7531` (`expressjs/express#7531`): reproduces exit code `9` in **`0.84s`** via `npx mocha test/app.listRoutes.js`.
  - `fail-10-werkzeug-pr-3269` (`pallets/werkzeug#3269`): reproduces exit code `1` in **`0.80s`** via `pytest tests/sansio/test_accept_mimetype_cases.py`.

> **Live Benchmark Status:** The 35-case benchmark corpus ([`bench/README.md`](./bench/README.md)), 2 local `<1s` anchor reproductions ([`bench/REPRO.md`](./bench/REPRO.md)), and the `preflight bench` evaluation runner (`src/bench/`) are implemented and unit-tested. Live LLM benchmark runs (`preflight bench --out bench/results`) have **not yet been executed** and will be published in a follow-up update once run against local Ollama and cloud providers. Preflight never reports fabricated or extrapolated benchmark scores.

---

## Project Status & Roadmap

- [x] **Phase 0 — Groundwork & Open-Source Architecture:** Technical specification ([`docs/SPEC.md`](./docs/SPEC.md)), ADRs ([`docs/DECISIONS.md`](./docs/DECISIONS.md)), provider/agent reference notes, `OpenAICompatibleClient` (7 built-in presets, single-flight queue, HTTP 429 `Retry-After`, secret redaction), 35-PR benchmark corpus, and 2 local `<1s` reproductions.
- [x] **Phase 1 — Core `Gather → Think → Verify` Pipeline & Telemetry:** Deterministic git diff + JS/TS & Python static import graph + `.github/workflows/*.yml` command parser + 5-tier `<= 20,000` estimated context token (`chars / 4`) budgeter; plain-text JSON Think contract with 1-retry schema validation; workflow-derived allowlist Verify runner with exit-code-only verdicts; Speed & Telemetry panel and `--json` contract.
- [x] **Phase 2 — `Explain`, Git `pre-push` Hook, Agent Skill & `preflight bench` Runner:** `preflight explain` (local files and GitHub Actions URLs with optional local verification), `preflight init --hook` (worktree/submodule-aware with `--force`), updated `skills/preflight/SKILL.md` + `docs/agent-setup.md`, and sequential `preflight bench` triage evaluation runner (`summary.md` & `results.json` export).
- [x] **Phase 3 — Adversarial Hardening & Security Audit:** Allowlist hardening against path traversal, flag/target swaps, and shell injection; secret redaction and bounded output capture (299 Vitest tests across 12 test files at Phase 3 completion, expanded further in Phase 5).
- [x] **Phase 4 — Story, README & Docs Polish:** Authoritative v0.1.0 README, CLI & JSON contract docs, synced technical specification, ADRs, and agent integration guides grounded directly in the codebase.
- [x] **Phase 5 — Final 3-Reviewer Audit Panel & Remediation:** Independent 3-reviewer code, security, and documentation panel review completed and remediated (env isolation via `~/.config/preflight/.env` / `--env-file`, custom base URL key guard, child-process key stripping, exact-match-only unmodeled tools, verbatim baseline flag preservation, Python binary & `@args.txt` blocking, Gather symlink/merge-base hardening, provider-safe `--think` payload gating, honest `bench` command-catch scoring, and full doc/skill sync).
- [ ] **Live Benchmark Run:** Execute `preflight bench --out bench/results` against local Ollama and cloud providers and publish verified recall, false-alarm, and throughput tables.

---

## Documentation

- [`docs/SPEC.md`](./docs/SPEC.md) — Full technical specification & pipeline architecture
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — Architecture Decision Records (`ADR-001` through `ADR-008`)
- [`docs/agent-setup.md`](./docs/agent-setup.md) — Setup guide for Claude Code, Codex, Cursor, OpenClaw, and Antigravity
- [`docs/notes/providers.md`](./docs/notes/providers.md) — Source-verified reference for OpenAI-compatible LLM providers
- [`docs/notes/agent-integrations.md`](./docs/notes/agent-integrations.md) — Source-verified reference for Agent Skills (`SKILL.md`), `--json` contract, and Git `pre-push` hooks
- [`skills/preflight/SKILL.md`](./skills/preflight/SKILL.md) — Portable Agent Skill definition for AI coding agents
- [`bench/README.md`](./bench/README.md) — 35-case GitHub PR benchmark corpus summary & curation methodology
- [`bench/REPRO.md`](./bench/REPRO.md) — End-to-end local `<1s` reproductions of failing CI PRs

---

## License

MIT License — see [`LICENSE`](./LICENSE).
