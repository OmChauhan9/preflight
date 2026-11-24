# Preflight

**Local-first, $0 CI pre-checks and failure diagnosis for developers and AI coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Default Provider: Ollama ($0 Local)](https://img.shields.io/badge/default%20LLM-Ollama%20(%240%20local)-orange.svg)](https://ollama.com/)

AI coding agents and developers iterate in seconds, push a branch or open a pull request, and then wait minutes for GitHub Actions to fail on a scoped unit test, typecheck, or lint rule broken by their diff. Running the entire CI suite locally after every edit is too slow; skipping checks entirely produces broken PRs.

**Preflight** closes that loop in seconds at **$0 cost**. Before you or your agent pushes code, Preflight inspects the local `git diff`, static import graph, and `.github/workflows/*.yml` definitions, asks an OpenAI-compatible LLM (defaulting to local **Ollama** with `qwen2.5-coder:7b`) which CI jobs and scoped commands are affected, executes only those workflow-derived commands locally, and reports the real command exit codes and latency telemetry. When remote CI has already failed, `preflight explain` diagnoses the failure log against your diff, proposes a minimal fix, and verifies it locally.

---

## Core Trust Invariant

> **An LLM decides *what* to check from your `git diff`, import graph, and `.github/workflows/*.yml`; real allowlisted scoped CI commands decide pass or fail via actual subprocess exit codes. Preflight never claims "CI will pass" — only "these checks passed" or "these checks failed".**

- **LLM for triage & diagnosis only:** The model maps a diff and workflow definition to the highest-signal subset of checks, or diagnoses a failure log.
- **Strict workflow-derived allowlist:** Every command proposed by the model must match a tool and subcommand already present in `.github/workflows/*.yml` (only narrowing scope to specific files or test filters). Arbitrary binaries, shell chaining (`;`, `&&`, `||`, `|`, `` ` ``, `$()`), redirection, or path traversal (`..`) are refused and logged.
- **100% exit-code-driven verdicts:** Every pass/fail result maps 1:1 to a real subprocess exit code executed in your working tree.

---

## How It Works (`Gather → Think → Verify` + `Explain`)

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. GATHER (Plain Code — Deterministic, 0 Tokens)                        │
│    • git diff vs base branch & changed file paths                       │
│    • Static import graph (JS/TS & Python) → affected test files         │
│    • Parsed .github/workflows/*.yml jobs & canonical run commands       │
│    • Deterministic 5-tier priority trimming to <= 20,000 input tokens:  │
│      (1) git diff → (2) CI commands → (3) changed files' tests →        │
│      (4) changed files → (5) neighbors                                  │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. THINK (Single LLM Call via OpenAICompatibleClient)                   │
│    • Default: local Ollama (qwen2.5-coder:7b, $0, no API key needed)    │
│    • Or any preset: groq, gemini, openrouter, openai, cerebras, custom  │
│    • Input: <= 20K tokens | max_completion_tokens: ~1,500               │
│    • Reasoning: off by default (opt-in via --think)                     │
│    • Plain-text JSON contract validated against schema + at most 1 retry│
│      { likely_failures[], affected_jobs[], commands[], notes }          │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. VERIFY (Plain Code — Safe Subprocess Execution)                      │
│    • Enforce workflow-derived command allowlist (same tool + subcommand,│
│      narrower file paths / test filters only)                           │
│    • Refuse & log any unapproved command or shell metacharacters        │
│    • Run approved commands with per-command timeouts                    │
│    • Verdict from real exit codes ("these checks passed / failed")      │
│    • Render Speed & Telemetry Panel (tokens, tok/s, stage wall times)   │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ 4. EXPLAIN (preflight explain <CI log URL or file>)                     │
│    • Read failing CI log + local git diff & .github/workflows/*.yml     │
│    • Single LLM call → root_cause + failing_command + suggested_patch   │
│    • Re-run allowlisted failing command locally when possible           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## $0 Local-First Default & Supported Providers

Preflight uses a single provider-agnostic `OpenAICompatibleClient` (`POST /chat/completions`). By default it connects to **local Ollama** (`http://localhost:11434/v1`) with **`qwen2.5-coder:7b`**, requiring **no API key and $0** to run. You can switch providers at any time via `--provider <preset>` or `PREFLIGHT_PROVIDER`.

| Preset (`--provider`) | Default Base URL | Default Model (`--model`) | Auth Env Var | Cost / Tier Notes |
| :--- | :--- | :--- | :--- | :--- |
| **`ollama`** *(default)* | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | `OLLAMA_API_KEY` *(optional)* | **$0 local-first** on your machine via [Ollama](https://ollama.com/) |
| **`groq`** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Cloud LPU inference (provider free tier subject to change) |
| **`gemini`** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | `GEMINI_API_KEY` | Google AI Studio API (provider free tier subject to change) |
| **`openrouter`** | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-coder-32b-instruct:free` | `OPENROUTER_API_KEY` | OpenRouter catalog (`:free` model availability subject to change) |
| **`openai`** | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` | Standard OpenAI pay-as-you-go API |
| **`cerebras`** | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | Wafer-scale inference with server `time_info` telemetry |
| **`custom`** | `PREFLIGHT_BASE_URL` *(required)* | `PREFLIGHT_MODEL` *(required)* | `PREFLIGHT_API_KEY` *(optional)* | Any OpenAI-compatible server (vLLM, LM Studio, llama.cpp, LiteLLM) |

Global environment variable overrides (`PREFLIGHT_PROVIDER`, `PREFLIGHT_MODEL`, `PREFLIGHT_BASE_URL`, `PREFLIGHT_API_KEY`) take precedence over preset defaults. See [`docs/notes/providers.md`](./docs/notes/providers.md) for source-verified endpoint documentation, rate-limit behavior, and payload details.

---

## Quickstart

> **Current v0.1.0 Scaffold Status:** `preflight check`, `preflight explain`, and `preflight bench` are currently wired as `not implemented` CLI stubs (printing `not implemented` and exiting with code `0`) while the Phase 1–2 `Gather → Think → Verify` and `Explain` pipeline is implemented next. The `OpenAICompatibleClient`, CLI argument parser, Agent Skill, and 35-case benchmark corpus are ready today.

### 1. Prerequisites & Installation

- **Node.js `>=22`** and **Git**
- For the default **$0 local workflow**, install [Ollama](https://ollama.com/) and pull the default coding model:

```bash
ollama pull qwen2.5-coder:7b
```

Clone and build Preflight:

```bash
git clone https://github.com/OmChauhan9/preflight.git
cd preflight
npm install
npm run build
```

### 2. Standalone CLI Usage

```bash
# Display CLI usage and available options
npx preflight --help

# Run preflight check (v0.1.0 stub currently prints "not implemented" and exits 0;
# Phase 1 will execute Gather -> Think -> Verify using local Ollama by default)
npx preflight check

# Planned Phase 1–2 CLI invocations & flags (accepted by the CLI parser today):
npx preflight check --json
GROQ_API_KEY=... npx preflight check --provider groq
GEMINI_API_KEY=... npx preflight check --provider gemini
OPENROUTER_API_KEY=... npx preflight check --provider openrouter
npx preflight check --provider ollama --model qwen2.5-coder:14b --think
npx preflight explain https://github.com/owner/repo/actions/runs/123456789
npx preflight explain ./ci-failure.log --json
npx preflight bench --provider ollama
```

### 3. AI Coding Agent Skill (`skills/preflight/SKILL.md`)

Preflight ships with a portable [Agent Skills](https://agentskills.io) definition at `skills/preflight/SKILL.md`. In the current v0.1.0 scaffold, the skill instructs agents to invoke `preflight check` (with fallbacks to `node dist/cli.js check` and `npx --no-install preflight check`) and report `stdout`, `stderr`, and the exit code verbatim (currently `not implemented` with exit code `0`), and defines the planned Phase 1 post-edit `preflight check --json` pre-push workflow:

- **Claude Code:** Copy or symlink `skills/preflight` to `.claude/skills/preflight`
- **OpenAI Codex:** Copy or symlink `skills/preflight` to `.codex/skills/preflight` (or `.agents/skills/preflight`)
- **Cursor:** Copy or symlink `skills/preflight` to `.cursor/skills/preflight` (or `.agents/skills/preflight`)
- **OpenClaw:** Copy or symlink `skills/preflight` to `<workspace>/skills/preflight` (or `~/.openclaw/skills/preflight`)
- **Antigravity:** Copy or symlink `skills/preflight` to `.agent/skills/preflight`

See [`docs/agent-setup.md`](./docs/agent-setup.md) and [`docs/notes/agent-integrations.md`](./docs/notes/agent-integrations.md) for per-agent setup instructions and the optional git `pre-push` hook (`preflight init --hook`, planned in Phase 1).

---

## Verified Benchmark Corpus (`bench/`)

Preflight includes a curated, hand-verified benchmark corpus of **35 real public GitHub Pull Request CI runs** in `bench/cases/*.json` across **10 open-source JavaScript/TypeScript and Python repositories**:

- **25 Failed-CI PRs (`fail-01` .. `fail-25`):** 13 unit test failures (`unit_test`), 5 typecheck failures (`typecheck`), and 7 lint/format failures (`lint_format`). Every case is dual-verified against both the verbatim GitHub Actions failure log and the exact commit diff (`base_sha..head_sha`) to confirm the failure was caused directly by the PR's code changes.
- **10 Passing-CI PRs (`pass-01` .. `pass-10`):** Clean passing PRs from the same 10 repositories (`expressjs/express`, `colinhacks/zod`, `unjs/h3`, `fastify/fastify`, `axios/axios`, `pallets/werkzeug`, `pallets/jinja`, `pallets/click`, `encode/httpx`, `pydantic/pydantic-settings`) to evaluate false-alarm rate and check scoping precision.
- **2 Local `<1s` Anchor Reproductions:** Documented end-to-end in [`bench/REPRO.md`](./bench/REPRO.md) (`fail-01-express-pr-7531` reproducing exit code `9` in `0.84s` via `npx mocha test/app.listRoutes.js`, and `fail-10-werkzeug-pr-3269` reproducing exit code `1` in `0.80s` via `pytest tests/sansio/test_accept_mimetype_cases.py`).

> **Benchmark Honesty Policy:** The 35-case benchmark corpus in [`bench/README.md`](./bench/README.md) and [`bench/REPRO.md`](./bench/REPRO.md) is fully curated and verified. Live `preflight bench` recall, precision, explanation accuracy, and provider latency numbers will be published once the core pipeline and benchmark runner are completed in Phases 1–2. Preflight never reports fabricated or extrapolated benchmark scores.

---

## Project Status & Roadmap

- [x] **Phase 0 — Groundwork & Open-Source Architecture (Complete):**
  - Technical specification ([`docs/SPEC.md`](./docs/SPEC.md)), ADRs ([`docs/DECISIONS.md`](./docs/DECISIONS.md)), and source-verified reference notes ([`docs/notes/providers.md`](./docs/notes/providers.md), [`docs/notes/agent-integrations.md`](./docs/notes/agent-integrations.md)).
  - Provider-agnostic `OpenAICompatibleClient` with local Ollama default, 7 built-in presets, single-flight queue, HTTP 429 `Retry-After` backoff, and secret redaction.
  - TypeScript/Node 22 CLI scaffold (`src/cli.ts`, where `preflight check`, `explain`, and `bench` currently print `not implemented` and exit `0`) and portable Agent Skill (`skills/preflight/SKILL.md`, [`docs/agent-setup.md`](./docs/agent-setup.md)).
  - Curated 35-PR benchmark corpus (`bench/cases/*.json`, [`bench/README.md`](./bench/README.md)) and 2 local `<1s` reproductions ([`bench/REPRO.md`](./bench/REPRO.md)).
- [ ] **Phase 1 — Core Pipeline Implementation (Next):**
  - `Gather` diff, static import graph (JS/TS & Python), `.github/workflows/*.yml` parser, and 5-tier context trimmer (`<= 20K` tokens).
  - `Think` prompt contract, JSON schema validator, and 1-retry error feedback loop.
  - `Verify` workflow-derived command allowlist enforcer, subprocess runner with timeouts, exit-code-only verdict reporter, and Speed/Telemetry panel.
  - `Explain` CI log fetcher/parser and root-cause diagnosis + optional `preflight init --hook` git `pre-push` hook installer.
- [ ] **Phase 2 — Benchmark Runner & Multi-Provider Evaluation:**
  - `preflight bench` execution across all 35 verified PR cases and published comparison tables across local Ollama and cloud OpenAI-compatible providers.

---

## Documentation

- [`docs/SPEC.md`](./docs/SPEC.md) — Full technical specification & pipeline architecture
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — Architecture Decision Records (`ADR-001` through `ADR-008`)
- [`docs/agent-setup.md`](./docs/agent-setup.md) — Setup guide for Claude Code, Codex, Cursor, OpenClaw, and Antigravity
- [`docs/notes/providers.md`](./docs/notes/providers.md) — Source-verified reference for OpenAI-compatible LLM providers
- [`docs/notes/agent-integrations.md`](./docs/notes/agent-integrations.md) — Source-verified reference for Agent Skills (`SKILL.md`) and Git `pre-push` hooks
- [`bench/README.md`](./bench/README.md) — 35-case GitHub PR benchmark corpus summary & curation methodology
- [`bench/REPRO.md`](./bench/REPRO.md) — End-to-end local `<1s` reproductions of failing CI PRs

---

## License

MIT License — see [`LICENSE`](./LICENSE).
