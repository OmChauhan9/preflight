# Preflight — Architecture Decision Records (ADRs)

This document records the core architectural decisions for **Preflight** (`https://github.com/OmChauhan9/preflight`), a local-first, $0 open-source CI pre-check and failure diagnosis tool for developers and AI coding agents. Each ADR captures the context, decision, rationale, and operational consequences.

---

## Index of Decisions

- [ADR-001: Plain-Text JSON Think Output Contract & Schema Validation/Retry](#adr-001-plain-text-json-think-output-contract--schema-validationretry)
- [ADR-002: Verify Command Allowlist & Exit-Code-Only Verdicts](#adr-002-verify-command-allowlist--exit-code-only-verdicts)
- [ADR-003: Context Budget (~20K Input Tokens, Priority Trimming, Low `max_completion_tokens`, Reasoning Off by Default)](#adr-003-context-budget-20k-input-tokens-priority-trimming-low-max_completion_tokens-reasoning-off-by-default)
- [ADR-004: Generic Agent Skill (`skills/preflight/SKILL.md`) + Optional Git `pre-push` Hook](#adr-004-generic-agent-skill-skillspreflightskillmd--optional-git-pre-push-hook)
- [ADR-005: Speed & Telemetry Panel & `--json` Output](#adr-005-speed--telemetry-panel--json-output)
- [ADR-006: Benchmark Dataset Design, Reproduction & Honesty Rules](#adr-006-benchmark-dataset-design-reproduction--honesty-rules)
- [ADR-007: Rate-Limit Protection, Secret Redaction & Single-Flight Execution](#adr-007-rate-limit-protection-secret-redaction--single-flight-execution)
- [ADR-008: Provider-Agnostic OpenAI-Compatible Client & Local-First $0 Default](#adr-008-provider-agnostic-openai-compatible-client--local-first-0-default)

---

## ADR-001: Plain-Text JSON Think Output Contract & Schema Validation/Retry

- **Status:** Accepted
- **Date:** 2026-11-23

### Context

The `Think` and `Explain` stages talk to a wide spectrum of OpenAI-compatible inference backends via `OpenAICompatibleClient` — ranging from local 7B coding models in Ollama (`qwen2.5-coder:7b`) and self-hosted vLLM/llama.cpp servers to cloud endpoints (Groq, Gemini, OpenRouter, OpenAI, and Cerebras). Different models and providers exhibit inconsistent support or divergent schemas for API-level `tools` / `tool_choice` and `response_format: { type: "json_schema" }`.

### Decision

1. **No Provider Tool Calling or Structured-Output Modes:** Preflight does not rely on API-level `tools` or `response_format` parameters for the `Think` and `Explain` stages.
2. **Plain-Text JSON Output Contract:** System prompts instruct the configured LLM to respond with a single plain-text JSON object containing:
   - `likely_failures[]`: Array of `{ category, target, reason }`
   - `affected_jobs[]`: Array of workflow job names from `.github/workflows/*.yml`
   - `commands[]`: Array of scoped workflow commands to execute
   - `notes`: Concise text summary
3. **Local Extraction, Schema Validation & Single Retry:**
   - The client strips any optional markdown code fences (`` ```json ... ``` ``), parses the JSON, and validates all required keys and value types locally.
   - If parsing or schema validation fails, Preflight performs **at most 1 retry**, appending the exact validation error message so the model can self-correct.
   - If the retry also fails validation, Preflight exits cleanly with an explicit schema validation error rather than retrying indefinitely or falling back to unvalidated output.

### Consequences

- Works identically across local Ollama models (`qwen2.5-coder:7b`) and every OpenAI-compatible cloud provider without provider-specific grammar adapters.
- Bounded failure behavior: at most 2 API calls per `Think` or `Explain` invocation even under malformed model output.

---

## ADR-002: Verify Command Allowlist & Exit-Code-Only Verdicts

- **Status:** Accepted
- **Date:** 2026-11-23

### Context

Executing shell commands proposed by an LLM in a developer's working tree carries two major risks:
1. **Security & Safety Risk:** An unconstrained LLM (or a prompt injection embedded in a git diff or CI log) could propose destructive commands, arbitrary shell pipelines, or commands unrelated to CI.
2. **Hallucinated Verdicts:** If an LLM determines whether code "passes CI", it can produce false confidence or hallucinate green checks without running real tools.

### Decision

1. **Separation of Responsibilities (Core Invariant):**
   - The LLM decides **what** to check (`affected_jobs[]`, `commands[]`).
   - Deterministic code in `Verify` runs real allowlisted commands and uses **only their subprocess exit codes** to decide pass/fail.
2. **Strict Workflow-Derived Command Allowlist:**
   - During `Gather`, Preflight parses `.github/workflows/*.yml` to extract the repository's canonical CI commands.
   - A command proposed by `Think` is permitted **only** if it matches the same tool and subcommand as a command defined in `.github/workflows/*.yml` (e.g., `npx vitest run`, `npx mocha`, `pytest`, `npm run typecheck`, `npm run lint`, `ruff check`, `tsc --noEmit`) and only narrows execution scope using safe relative file paths or test-filter arguments.
   - Any command containing shell metacharacters/chaining (`;`, `&&`, `||`, `|`, `` ` ``, `$()`, `>`, `<`), path traversal (`..`), or unapproved executables is **refused and logged**.
3. **Timeouts & Honest Verdict Language:**
   - Every executed command is subject to a strict per-command timeout.
   - Preflight reports **"these checks passed"** (all executed exit codes `0`) or **"these checks failed"** (any non-zero exit code or timeout), and **never** claims `"CI will pass"`.

### Consequences

- Zero arbitrary command execution from LLM hallucinations or prompt injection in diffs/logs.
- Developers and coding agents can trust a failure or pass report because every verdict maps 1:1 to a real command and exit code.

---

## ADR-003: Context Budget (~20K Input Tokens, Priority Trimming, Low `max_completion_tokens`, Reasoning Off by Default)

- **Status:** Accepted
- **Date:** 2026-11-23

### Context

Local models running on consumer hardware (such as Ollama with `qwen2.5-coder:7b`) degrade in latency and KV-cache memory when prompts exceed 20K–32K tokens, and free-tier cloud providers (such as Groq, Gemini free tier, OpenRouter `:free`, and Cerebras) enforce strict tokens-per-minute limits (with some endpoints pre-charging `max_completion_tokens` on request arrival). Furthermore, large PR diffs or noisy CI logs can easily exceed 50K tokens if sent raw, and enabling unbounded chain-of-thought reasoning by default increases latency and risks truncating the JSON payload.

### Decision

1. **Input Token Cap (`<= 20,000` tokens):**
   - `Gather` enforces a hard budget of `~20,000` input tokens per LLM request.
   - Context is assembled and trimmed in deterministic 5-tier priority order:
     1. `(1) git diff` (unified diff hunks for modified files)
     2. `(2) CI commands` (parsed `.github/workflows/*.yml` jobs and commands)
     3. `(3) changed files' tests` (test files importing changed modules via the static import graph)
     4. `(4) changed files` (full or surrounding source context of modified files)
     5. `(5) neighbors` (adjacent modules in the local import graph)
   - Trimming proceeds in **reverse priority order** (dropping `(5) neighbors` first, then `(4) changed files`, `(3) changed files' tests`, etc.) to stay within `<= ~20,000` input tokens. (When running `preflight explain`, the failing CI log excerpt is included alongside the high-priority diff and workflow commands.)
2. **Low `max_completion_tokens` (`~1,500`):**
   - Requests explicitly cap completion output at `~1,500` tokens (`<= 2,000`) so responses stay compact and pre-charged token quotas are preserved.
3. **Reasoning Off by Default (`--think` Opt-In):**
   - Reasoning is off by default for low latency and compact JSON output, and can be enabled explicitly via the `--think` CLI flag.

### Consequences

- Predictable per-request token footprint (`<= 21.5K` total tokens worst-case), running fast on local laptops via Ollama while avoiding HTTP 429 rate-limit exhaustion on cloud free tiers.

---

## ADR-004: Generic Agent Skill (`skills/preflight/SKILL.md`) + Optional Git `pre-push` Hook

- **Status:** Accepted
- **Date:** 2026-11-23

### Context

Developers use a variety of AI coding agents — including **Claude Code**, **OpenAI Codex**, **Cursor**, **OpenClaw**, and **Antigravity** — as well as standard manual `git push` workflows in the terminal. Tying Preflight to a single proprietary agent harness would limit adoption and require separate plugins for each tool.

### Decision

1. **Cross-Agent Open `SKILL.md` Standard (`skills/preflight/SKILL.md`):**
   - Package Preflight's agent integration using the open [Agent Skills specification](https://agentskills.io/specification) (`SKILL.md` with YAML frontmatter `name` and `description` plus markdown operating instructions), documented in [`docs/agent-setup.md`](./agent-setup.md) and [`docs/notes/agent-integrations.md`](./notes/agent-integrations.md).
   - The same `skills/preflight/SKILL.md` directory installs directly into Claude Code (`.claude/skills/preflight`), Codex (`.codex/skills/preflight` or `.agents/skills/preflight`), Cursor (`.cursor/skills/preflight` or `.agents/skills/preflight`), OpenClaw (`<workspace>/skills/preflight`), and Antigravity (`.agent/skills/preflight`).
2. **Universal CLI `--json` Contract & Direct Shell Fallback:**
   - All agent skills and shell integrations invoke the same `preflight check --json` and `preflight explain <log> --json` CLI commands. Agents without skill loaders can call `preflight check --json` directly via their standard shell execution tool.
3. **Optional Git `pre-push` Hook (`preflight init --hook`, Planned in Phase 1):**
   - Provide `preflight init --hook` to install a local `.git/hooks/pre-push` hook that runs `preflight check` automatically before `git push` transfers commits to a remote, blocking pushes when allowlisted checks fail with a non-zero exit code.

### Consequences

- Zero vendor or harness lock-in: one CLI contract (`--json` + exit codes) and one portable `SKILL.md` file support every major AI coding agent and standard Git workflows.

---

## ADR-005: Speed & Telemetry Panel & `--json` Output

- **Status:** Accepted
- **Date:** 2026-11-23

### Context

Because Preflight supports both local inference (Ollama on CPU/Apple Silicon/GPU) and cloud providers (Groq, Gemini, OpenRouter, OpenAI, Cerebras, custom servers), developers need transparent visibility into where wall-clock time is spent (`Gather` vs `Think` vs `Verify`) and how fast their chosen model triages diffs.

### Decision

1. **Always-On Speed & Telemetry Panel:**
   - Every CLI run renders a concise **Speed & Telemetry Panel** showing:
     - Active `provider` and `model`
     - `prompt_tokens`, `completion_tokens`, and `total_tokens` from `usage`
     - `tok/s` throughput (computed from `usage.completion_tokens / time_info.completion_time` when the provider supplies `time_info`, or `usage.completion_tokens / (wallTimeMs / 1000)` using client wall-clock timing)
     - Optional provider `time_info` breakdown (`queue_time`, `prompt_time`, `completion_time`, `total_time`) when present in the response
     - Stage-by-stage wall time breakdown: `gather_ms`, `think_ms`, `verify_ms`, and `total_wall_ms`
2. **Structured `--json` Parity:**
   - Passing `--json` outputs the full `telemetry` object alongside `gather`, `think`, `verify`/`explain`, and `provider` metadata so coding agents and `preflight bench` can programmatically inspect and compare providers.

### Consequences

- Makes inference latency vs local test execution time immediately visible on every run and enables reproducible multi-provider benchmarking.

---

## ADR-006: Benchmark Dataset Design, Reproduction & Honesty Rules

- **Status:** Accepted
- **Date:** 2026-11-23

### Context

To evaluate whether Preflight selects the right checks, catches real regressions, avoids false alarms on passing changes, and diagnoses CI logs accurately across models, we need an empirical benchmark grounded in real open-source pull requests rather than synthetic toy examples.

### Decision

1. **Curated 35-PR Dataset (`bench/cases/*.json`):**
   - Curate **25 failed-CI PRs** (`fail-01` .. `fail-25`) and **10 passing-CI PRs** (`pass-01` .. `pass-10`) across **10 public JavaScript/TypeScript and Python GitHub repositories** with GitHub Actions workflows and fast local test suites (`expressjs/express`, `colinhacks/zod`, `unjs/h3`, `fastify/fastify`, `axios/axios`, `pallets/werkzeug`, `pallets/jinja`, `pallets/click`, `encode/httpx`, and `pydantic/pydantic-settings`).
2. **Strict Inclusion Criteria for Failed PRs:**
   - The CI failure must be directly caused by a defect in the PR's changed code (13 `unit_test`, 5 `typecheck`, and 7 `lint_format` cases).
   - Exclude infra outages, runner provisioning failures, upstream bundler/packaging drift unrelated to the diff, flaky timing warnings, and spam PRs (12 raw candidates audited and rejected in [`bench/README.md`](../bench/README.md)).
   - Record the exact `base_sha` and `head_sha` commit where CI failed.
3. **Hand-Verified Labels (`label_verified`):**
   - Every case is cross-checked against **both** the actual GitHub Actions failure log (`log_excerpt`, `failing_job`, `failing_command`) and the git diff between `base_sha` and `head_sha`, recorded in `label_verified: { checked_against_log: true, checked_against_diff: true, notes: "..." }`.
4. **Local `<1s` Anchor Reproductions ([`bench/REPRO.md`](../bench/REPRO.md)):**
   - Reproduce 2 failed-CI anchor cases (`fail-01-express-pr-7531` in `0.84s` and `fail-10-werkzeug-pr-3269` in `0.80s`) end-to-end locally from checkout through scoped command failure to prove local verification speed and fidelity.
5. **Uncompromising Honesty Rule:**
   - Report exact results and denominators from real runs only after `preflight bench` executes in Phase 2. Never fabricate metrics, never hide cases where a model misses a target command, and clearly distinguish static diff/log evaluation across the full 35-case corpus from full local command execution runs.

### Consequences

- High-credibility evaluation that developers can inspect case-by-case via real GitHub PR and workflow run URLs.

---

## ADR-007: Rate-Limit Protection, Secret Redaction & Single-Flight Execution

- **Status:** Accepted
- **Date:** 2026-11-23

### Context

Local inference servers (such as Ollama on a single GPU/CPU) thrash memory if hit with concurrent requests, while cloud free-tier endpoints enforce strict requests-per-minute and tokens-per-minute limits. Parallel requests during `preflight bench` or rapid agent retries could trigger local OOMs or bursts of HTTP `429 Too Many Requests` errors. Additionally, error logs must never leak API keys.

### Decision

1. **Single-Flight Request Queue (`concurrency = 1`):**
   - All `OpenAICompatibleClient` calls execute through a process-wide single-flight FIFO mutex queue so only one LLM inference request is in flight at any time.
2. **HTTP 429 Backoff with `Retry-After`:**
   - On HTTP `429`, the HTTP client inspects the `Retry-After` response header (in delta-seconds or HTTP-date) when present, falling back to bounded exponential backoff with random jitter before retrying.
3. **Secret Redaction:**
   - API keys are read strictly from environment variables (`PREFLIGHT_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`). Any thrown errors or debug logs scrub `Authorization` headers and key values (`[REDACTED]`).

### Consequences

- Benchmark loops (`preflight bench`) and retry paths run reliably on both local hardware and cloud rate limits without cascading 429 failures or accidental credential leaks.

---

## ADR-008: Provider-Agnostic OpenAI-Compatible Client & Local-First $0 Default

- **Status:** Accepted
- **Date:** 2026-11-23

### Context

An open-source developer tool should cost **$0** to install, try, and run locally without mandatory cloud signups or paid API keys, while still letting developers opt into fast free-tier or cloud inference providers when desired. Maintaining separate SDK dependencies for each LLM vendor adds bloat and maintenance burden.

### Decision

1. **Single Zero-Dependency `OpenAICompatibleClient`:**
   - Implement a single standard `fetch`-based `OpenAICompatibleClient` in TypeScript targeting `POST {baseUrl}/chat/completions`, configured via `PREFLIGHT_PROVIDER`, `PREFLIGHT_MODEL`, `PREFLIGHT_BASE_URL`, and `PREFLIGHT_API_KEY` (with provider-specific API key fallbacks).
2. **Local-First $0 Default (`ollama`):**
   - Default to **`ollama`** (`http://localhost:11434/v1`) with model **`qwen2.5-coder:7b`** and no required API key, enabling a 100% local, zero-cost out-of-the-box experience.
3. **Seven Built-In Provider Presets:**
   - Ship built-in presets for:
     - `ollama` (`http://localhost:11434/v1`, `qwen2.5-coder:7b`, no API key)
     - `groq` (`https://api.groq.com/openai/v1`, `GROQ_API_KEY`, `llama-3.3-70b-versatile`)
     - `gemini` (`https://generativelanguage.googleapis.com/v1beta/openai`, `GEMINI_API_KEY`, `gemini-2.5-flash`)
     - `openrouter` (`https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`, `qwen/qwen-2.5-coder-32b-instruct:free`)
     - `openai` (`https://api.openai.com/v1`, `OPENAI_API_KEY`, `gpt-4o-mini`)
     - `cerebras` (`https://api.cerebras.ai/v1`, `CEREBRAS_API_KEY`, `llama-3.3-70b`)
     - `custom` (`PREFLIGHT_BASE_URL`, `PREFLIGHT_MODEL`, optional `PREFLIGHT_API_KEY` for vLLM, LM Studio, llama.cpp, LiteLLM, etc.)

### Consequences

- Preflight costs **$0** to develop, test, and run locally while supporting every major cloud and self-hosted OpenAI-compatible inference engine through a single tested client.
