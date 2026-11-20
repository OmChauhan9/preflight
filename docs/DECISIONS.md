# Preflight — Architecture Decision Records (ADRs)

This document records the core architectural decisions established for **Preflight** prior to hackathon kickoff. Each ADR captures the context, decision, rationale, and operational consequences.

---

## Index of Decisions

- [ADR-001: Plain-Text JSON Think Output Contract & Schema Validation/Retry](#adr-001-plain-text-json-think-output-contract--schema-validationretry)
- [ADR-002: Verify Command Allowlist & Exit-Code-Only Verdicts](#adr-002-verify-command-allowlist--exit-code-only-verdicts)
- [ADR-003: Context Budget (~20K Input Tokens, Priority Trimming, Low `max_completion_tokens`, Reasoning Off by Default)](#adr-003-context-budget-20k-input-tokens-priority-trimming-low-max_completion_tokens-reasoning-off-by-default)
- [ADR-004: OpenClaw Agent Trigger (Tool/Skill Preferred, Shell Fallback)](#adr-004-openclaw-agent-trigger-toolskill-preferred-shell-fallback)
- [ADR-005: Speed Panel Telemetry & `--json` Output](#adr-005-speed-panel-telemetry--json-output)
- [ADR-006: Benchmark Dataset Design, Reproduction & Honesty Rules](#adr-006-benchmark-dataset-design-reproduction--honesty-rules)
- [ADR-007: Rate-Limit Protection & Single-Flight Kimi Execution](#adr-007-rate-limit-protection--single-flight-kimi-execution)
- [ADR-008: 60-Second Video Structure & Cut Order](#adr-008-60-second-video-structure--cut-order)

---

## ADR-001: Plain-Text JSON Think Output Contract & Schema Validation/Retry

- **Status:** Accepted
- **Date:** 2026-11-19

### Context

The `Think` stage calls `moonshotai-kimi-k3.1-pro-trial` on Cerebras (`https://api.cerebras.ai/v1/chat/completions`) and must also work identically against a standard GPU-backed Kimi endpoint (`--provider gpu`) for side-by-side comparison. Preview/trial model endpoints can exhibit subtle differences or limitations in provider-enforced `tools` / `tool_choice` or `response_format: { type: "json_schema" }` support across providers.

### Decision

1. **No Provider Tool Calling or Structured-Output Modes:** Preflight will not rely on API-level `tools` or `response_format` parameters for the `Think` and `Explain` stages.
2. **Plain-Text JSON Output Contract:** Prompts instruct Kimi K3.1 Pro to respond with a single plain-text JSON object containing:
   - `likely_failures[]`: Array of `{ category, target, reason }`
   - `affected_jobs[]`: Array of workflow job names
   - `commands[]`: Array of scoped workflow commands to execute
   - `notes`: Concise text summary
3. **Local Extraction, Schema Validation & Single Retry:**
   - The client strips any optional markdown code fences (`` ```json ... ``` ``), parses the JSON, and validates all required keys and value types locally.
   - If parsing or schema validation fails, Preflight performs **at most 1 retry**, appending the validation error message so Kimi can self-correct.
   - If the retry also fails validation, Preflight exits cleanly with an explicit schema validation error rather than retrying indefinitely or falling back to unvalidated output.

### Consequences

- Works identically across Cerebras (`moonshotai-kimi-k3.1-pro-trial`) and Moonshot's GPU endpoint (`--provider gpu`).
- Bounded failure behavior: at most 2 API calls per `Think` invocation even under malformed output.

---

## ADR-002: Verify Command Allowlist & Exit-Code-Only Verdicts

- **Status:** Accepted
- **Date:** 2026-11-19

### Context

Executing shell commands proposed by an LLM in a developer's working tree carries two major risks:
1. **Security & Safety Risk:** An unconstrained LLM could propose destructive commands, arbitrary shell pipelines, or commands unrelated to CI.
2. **Hallucinated Verdicts:** If an LLM determines whether code "passes CI", it can produce false confidence or hallucinate green checks without running real tools.

### Decision

1. **Separation of Responsibilities (Core Invariant):**
   - Kimi K3.1 Pro on Cerebras decides **what** to check (`affected_jobs[]`, `commands[]`).
   - Deterministic code in `Verify` runs real commands and uses **only their subprocess exit codes** to decide pass/fail.
2. **Strict Workflow-Derived Command Allowlist:**
   - During `Gather`, Preflight parses `.github/workflows/*.yml` to extract the repository's canonical CI commands.
   - A command proposed by `Think` is permitted **only** if it matches the same tool and subcommand as a command defined in `.github/workflows/*.yml` (e.g., `npx vitest run`, `pytest`, `npm run typecheck`, `npm run lint`, `ruff check`, `tsc --noEmit`) and only narrows execution scope using safe relative file paths or test-filter arguments.
   - Any command containing shell metacharacters/chaining (`;`, `&&`, `||`, `|`, `` ` ``, `$()`, `>`, `<`), path traversal (`..`), or unapproved executables is **refused and logged**.
3. **Timeouts & Honest Verdict Language:**
   - Every executed command is subject to a strict timeout.
   - Preflight reports **"these checks passed"** (all executed exit codes `0`) or **"these checks failed"** (any non-zero exit code or timeout), and **never** claims `"CI will pass"`.

### Consequences

- Zero arbitrary command execution from LLM hallucinations or prompt injection in diffs/logs.
- Developers and coding agents can trust a failure or pass report because every verdict maps 1:1 to a real command and exit code.

---

## ADR-003: Context Budget (~20K Input Tokens, Priority Trimming, Low `max_completion_tokens`, Reasoning Off by Default)

- **Status:** Accepted
- **Date:** 2026-11-19

### Context

The Cerebras trial endpoint enforces a **100,000 tokens/minute** quota and **pre-charges the full requested `max_completion_tokens`** against that budget when a request begins. Large PR diffs or noisy CI logs can easily exceed 50K tokens if sent raw, and enabling unbounded chain-of-thought reasoning by default would consume completion token quota and risk truncating the final JSON payload.

### Decision

1. **Input Token Cap (`<= 20,000` tokens):**
   - `Gather` enforces a hard budget of `~20,000` input tokens per Kimi request.
   - Context is assembled and trimmed in deterministic priority order:
     1. Parsed `.github/workflows/*.yml` jobs and commands (highest priority — small and required for allowlist alignment)
     2. List of changed files and import-graph-matched test files
     3. Recent CI failure log excerpt (when running `explain` or when a log is attached, capped to the failing command + traceback lines)
     4. Unified `git diff` hunks (trimmed symmetrically per file if the diff exceeds remaining token budget, prioritizing modified source and test files over lockfiles or generated artifacts)
2. **Low `max_completion_tokens` (`~1,500`):**
   - Requests explicitly set `max_completion_tokens: 1500` (never leaving it unset or defaulting to 8K–32K) so Cerebras pre-charging consumes only ~1.5% of the per-minute token budget per call.
3. **Reasoning Off by Default (`--think` Opt-In):**
   - By default, `reasoning_effort` is omitted so Kimi emits the JSON response directly with minimal latency and token usage.
   - Users can opt into reasoning via the `--think` CLI flag (using the `reasoning_effort` value confirmed for `moonshotai-kimi-k3.1-pro-trial` at kickoff).

### Consequences

- Predictable per-request token cost (`<= 21.5K` total pre-charged tokens worst-case), allowing multiple back-to-back runs per minute without hitting HTTP 429 limits.
- Sub-second to low-second inference latency on Cerebras during normal `preflight check` runs.

---

## ADR-004: OpenClaw Agent Trigger (Tool/Skill Preferred, Shell Fallback)

- **Status:** Accepted
- **Date:** 2026-11-19

### Context

Preflight is built for AI coding agents running inside the **OpenClaw** harness configured with `@openclaw/cerebras-provider` (`moonshotai-kimi-k3.1-pro-trial`). We want the cleanest possible native integration with OpenClaw without risking hackathon schedule slips on harness-specific plugin edge cases.

### Decision

1. **Primary / Preferred Path — Native OpenClaw Skill / Tool:**
   - Expose Preflight as a registered OpenClaw skill/tool that executes `preflight check --json` (and `preflight explain <log> --json`) and returns structured JSON output directly to the OpenClaw agent.
2. **Immediate Fallback — OpenClaw Shell Execution:**
   - Because `preflight` is a standard executable CLI with `--json` output and deterministic exit codes, if OpenClaw skill registration introduces any friction, the OpenClaw agent invokes `preflight check --json` directly via its built-in shell execution tool.
3. **Phase 0 Groundwork Verification:**
   - Verify OpenClaw installation (with user confirmation) and confirm that an OpenClaw agent can invoke the Phase 0 `preflight check` stub and display its output.

### Consequences

- Both paths use the exact same `preflight check --json` CLI contract, so zero core logic changes are required regardless of how OpenClaw triggers the binary.

---

## ADR-005: Speed Panel Telemetry & `--json` Output

- **Status:** Accepted
- **Date:** 2026-11-19

### Context

A core goal of the Cerebras × Kimi K3.1 Pro Hackathon is demonstrating *why* Cerebras wafer-scale inference speed qualitatively changes the developer and agent workflow compared to traditional GPU inference providers.

### Decision

1. **Always-On Speed Panel:**
   - Every CLI run renders a concise **Speed Panel** showing:
     - `prompt_tokens`, `completion_tokens`, and `total_tokens` from `usage`
     - `tok/s` throughput (`usage.completion_tokens / time_info.completion_time` on Cerebras; fallback to client-measured completion tokens/sec on `--provider gpu`)
     - All four Cerebras `time_info` fields: `queue_time`, `prompt_time`, `completion_time`, `total_time`
     - Stage-by-stage wall time breakdown: `gather_ms`, `think_ms`, `verify_ms`, and `total_wall_ms`
2. **Note on SSE Streaming:**
   - Because Cerebras SSE streaming can bundle multiple tokens per SSE chunk, throughput metrics always rely on the authoritative `usage` and `time_info` fields rather than counting client-side stream events.
3. **Structured `--json` Parity:**
   - Passing `--json` outputs the full telemetry block alongside `gather`, `think`, `verify`/`explain`, and `provider` metadata so OpenClaw and `preflight bench` can programmatically inspect and compare providers.

### Consequences

- Makes the Cerebras speed advantage immediately visible in every terminal run and benchmark comparison table.

---

## ADR-006: Benchmark Dataset Design, Reproduction & Honesty Rules

- **Status:** Accepted
- **Date:** 2026-11-19

### Context

To prove that Preflight selects the right checks, catches real regressions, avoids false alarms on passing changes, and diagnoses CI logs accurately, we need an empirical benchmark grounded in real open-source pull requests rather than synthetic toy examples.

### Decision

1. **Dataset Size & Balance (`bench/cases/*.json`):**
   - Curate **20–30 failed-CI PRs** (`fail-*.json`) and **~10 passing-CI PRs** (`pass-*.json`) from real public JS/TS and Python GitHub repositories with GitHub Actions workflows and fast local test suites (`< 2 minutes` local execution).
2. **Strict Inclusion Criteria for Failed PRs:**
   - The CI failure must be directly caused by a defect in the PR's changed code (unit test failure, typecheck error, lint error, or assertion failure).
   - Exclude infra outages, missing secrets, flaky unrelated tests, and automated dependency bumps.
   - Record the exact `base_sha` and `head_sha` commit where CI failed (important when a PR was later fixed by subsequent commits before merging).
3. **Hand-Verified Labels (`label_verified`):**
   - Every case must be cross-checked against **both** the actual GitHub Actions failure log (`log_excerpt`, `failing_job`, `failing_command`) and the git diff between `base_sha` and `head_sha`, recorded in `label_verified: { checked_against_log: true, checked_against_diff: true, notes: "..." }`.
4. **Local Reproduction in Phase 0:**
   - Reproduce at least **2 failed-CI cases** locally from checkout through test failure during Phase 0 to prove that local verification works cleanly.
5. **Uncompromising Honesty Rule:**
   - Report exact results and denominators from real runs. Never fabricate metrics, never hide cases where Kimi misses a target command, and clearly distinguish static diff/log evaluation across the full dataset from full local command execution runs.

### Consequences

- High-credibility evaluation that judges and developers can inspect case-by-case via real GitHub PR and workflow run URLs.

---

## ADR-007: Rate-Limit Protection & Single-Flight Kimi Execution

- **Status:** Accepted
- **Date:** 2026-11-19

### Context

The Cerebras trial tier enforces **100 requests/min** and **100,000 tokens/min**, with `max_completion_tokens` pre-charged on request arrival. Parallel requests during `preflight bench` or rapid agent retries could trigger bursts of HTTP `429 Too Many Requests` errors. Additionally, error logs must never leak `CEREBRAS_API_KEY` or `MOONSHOT_API_KEY`.

### Decision

1. **Single-Flight Request Queue (`concurrency = 1`):**
   - All LLM client calls (`CerebrasClient` and `GpuProviderClient`) execute through a process-wide single-flight mutex queue so only one Kimi inference request is in flight at any time.
2. **HTTP 429 Backoff with `Retry-After`:**
   - On HTTP `429`, the HTTP client inspects the `Retry-After` response header (in seconds or HTTP-date) when present, falling back to bounded exponential backoff with random jitter before retrying.
3. **Secret Redaction:**
   - API keys are read strictly from environment variables (`CEREBRAS_API_KEY`, `MOONSHOT_API_KEY`). Any thrown errors or debug logs scrub `Authorization` headers and key values.

### Consequences

- Benchmark loops (`preflight bench`) and retry paths run reliably without cascading 429 failures or accidental credential leaks.

---

## ADR-008: 60-Second Video Structure & Cut Order

- **Status:** Accepted
- **Date:** 2026-11-19

### Context

Hackathon judging relies heavily on a public X post containing a **<= 60-second demo video**. Teams often run out of time for video production or dilute the demo with peripheral features.

### Decision

1. **Locked 60-Second Video Storyboard:**
   - **0:00–0:08 (Hook):** The multi-minute CI wait problem for AI coding agents.
   - **0:08–0:25 (Core Loop):** OpenClaw agent runs `preflight check`; Kimi K3.1 Pro on Cerebras selects scoped workflow checks; Verify catches a real failure via exit code.
   - **0:25–0:38 (Explain & Fix):** Root-cause diagnosis and re-verification passing with exit code `0`.
   - **0:38–0:50 (Speed Comparison):** Side-by-side `--provider cerebras` vs `--provider gpu` Speed Panel (`tok/s`, `time_info`, wall-clock savings).
   - **0:50–1:00 (Benchmark & CTA):** Honest results across the 30+ real GitHub PR benchmark dataset + public repo link.
2. **Strict Scope Cut Order:**
   - If time runs short, cut in this order:
     1. Optional web UI / dashboard (never start unless everything else is done)
     2. Automated patch application in `preflight explain` (keep diagnosis + printed diff + command re-run)
     3. Multi-hop transitive import graph analysis (keep direct 1-hop import + path heuristics + workflow parsing)
     4. Native OpenClaw skill wrapper if blocked (use OpenClaw shell invocation of `preflight check --json`)
   - **Never cut:** `preflight check` allowlisted exit-code verification, Cerebras Speed Panel + `--provider` comparison, `preflight explain`, benchmark table, and the 60-second video.

### Consequences

- Guarantees a sharp, high-signal submission on Sunday without sacrificing the core invariant or benchmark integrity.
