# Preflight — Technical Specification

> **Fast CI pre-checks for AI coding agents, powered by Kimi K3.1 Pro on Cerebras and the OpenClaw harness.**  
> Built for the Cerebras × Kimi K3.1 Pro Hackathon (Nov 21–22, 2026).

---

## 1. Product Summary & Core Invariant

AI coding agents iterate quickly in a local repository, commit or open a pull request, and then wait minutes for GitHub Actions CI to fail on a scoped test, typecheck, or lint error caused directly by their diff. Running the entire CI suite locally after every edit is too slow; skipping checks entirely leads to broken PRs.

**Preflight** closes this feedback loop in seconds. Before an agent pushes code or opens a PR, Preflight inspects the local git diff, static import graph, and `.github/workflows/*.yml` definitions, asks **Kimi K3.1 Pro on Cerebras** which CI jobs and scoped commands are most likely affected by the change, executes only those safe, workflow-derived commands locally, and reports the actual command results and Cerebras latency breakdown. When CI has already failed remotely, `preflight explain` diagnoses the failure log against the diff, proposes a minimal fix, and verifies it locally when possible.

### Core Invariant

> **Kimi K3.1 Pro on Cerebras decides *what* to check; real commands and exit codes decide pass/fail. Preflight never claims "CI will pass".**

- The LLM is used strictly for **triage, scoping, and root-cause explanation**: mapping a code diff and workflow definition to the highest-signal subset of checks, or diagnosing a failure log.
- Pass/fail verdicts come **100% from real subprocess exit codes** of allowlisted commands executed in the repository.
- Preflight output always states **"these checks passed / these checks failed"** (along with exact commands and exit codes) and never promises that full remote CI will pass.

---

## 2. Pipeline Architecture & Stages

Preflight operates as a four-stage pipeline (`Gather → Think → Verify`, plus on-demand `Explain`):

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. GATHER (Plain Code)                                                  │
│    • git diff vs base branch & changed file paths                       │
│    • Static import graph → test files transitively importing changes    │
│    • Parsed .github/workflows/*.yml jobs & run commands                 │
│    • Optional recent CI failure log excerpt                             │
│    • Deterministic priority trimming to <= 20,000 input tokens          │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. THINK (Single Kimi K3.1 Pro Call on Cerebras)                        │
│    • Model: moonshotai-kimi-k3.1-pro-trial (concurrency = 1)            │
│    • Input: <= 20K tokens | max_completion_tokens: ~1,500               │
│    • Reasoning: off by default (opt-in via --think)                     │
│    • Plain-text JSON output contract:                                   │
│      { likely_failures[], affected_jobs[], commands[], notes }          │
│    • Local JSON schema validation + at most 1 error-feedback retry      │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. VERIFY (Plain Code)                                                  │
│    • Allowlist enforcement against workflow-derived commands            │
│      (same tool + subcommand, narrower file paths / test filters only)  │
│    • Refuse & log any unapproved command or shell injection             │
│    • Execute approved commands with strict timeouts                     │
│    • Verdict computed solely from real exit codes                       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ 4. EXPLAIN (preflight explain <CI log URL or file>)                     │
│    • Fetch/read failing CI log + local git diff & workflow context      │
│    • Single Kimi K3.1 Pro call → root cause + minimal suggested patch   │
│    • Re-run the failing command locally when possible to verify fix     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Stage 1: Gather (Plain Code)

Deterministic, zero-LLM local context collection:

1. **Git Diff & Changed Files:** Runs `git diff` against the target base branch (or merge-base) to collect changed file paths, change statuses, and unified diff hunks.
2. **Import Graph & Affected Tests:** Parses local JS/TS (`import`/`require`) and Python (`import`/`from ... import`) dependencies to identify test files that directly or transitively import modified source modules.
3. **Workflow Command Extraction:** Parses `.github/workflows/*.yml` (and `.yaml`) files to extract job names, working directories, matrix hints, and `run:` shell steps (e.g., `npm test`, `npx vitest run`, `npm run typecheck`, `npm run lint`, `pytest`, `ruff check`, `mypy`).
4. **Optional Recent CI Log:** If provided or available from recent failure state, attaches a bounded failure log excerpt.
5. **Context Budgeting:** Priority-trims gathered context to guarantee the prompt stays within **<= 20,000 input tokens** (see Section 6).

### Stage 2: Think (Single Kimi K3.1 Pro Call on Cerebras)

A single inference call to `moonshotai-kimi-k3.1-pro-trial` on `https://api.cerebras.ai/v1/chat/completions`:

- **Token Budget:** `<= 20,000` input tokens; `max_completion_tokens` capped at **`~1,500`** (preventing pre-charge exhaustion of the 100K tokens/min quota).
- **Reasoning Mode:** Off by default so latency stays ultra-low and completions are not truncated by hidden reasoning tokens. Can be enabled explicitly with `--think`.
- **Plain-Text JSON Contract:** Preflight does not depend on provider-specific tool calling (`tools`) or structured-output modes (`response_format: { type: "json_schema" }`). Instead, the system prompt specifies a strict plain-text JSON contract:

```json
{
  "likely_failures": [
    {
      "category": "test",
      "target": "test/client.test.ts",
      "reason": "Diff modifies retry header parsing in src/clients/http.ts imported by test/client.test.ts"
    }
  ],
  "affected_jobs": ["test", "typecheck"],
  "commands": [
    "npx vitest run test/client.test.ts",
    "npm run typecheck"
  ],
  "notes": "Retry-After parsing logic changed; run unit tests for HTTP client and full typecheck."
}
```

- **Required Output Fields:**
  - `likely_failures[]`: Array of objects describing predicted failure points (`category`, `target`, `reason`).
  - `affected_jobs[]`: Array of workflow job identifiers from `.github/workflows/*.yml` impacted by the diff.
  - `commands[]`: Ordered list of scoped commands derived from the workflow commands to run in Verify.
  - `notes`: Short human- and agent-readable summary of what is being checked and why.
- **Validation & Retry Policy:**
  - Extract JSON object from the completion text (stripping optional markdown code fences if present) and validate all required fields and types.
  - If JSON parsing or schema validation fails, perform **at most 1 retry**, passing the exact validation error message back to Kimi.
  - If the retry also fails validation, abort the Think stage with a clear, structured error message rather than looping or silently guessing.

### Stage 3: Verify (Plain Code)

Safe, deterministic local command execution:

1. **Workflow-Derived Allowlist:**
   - Every candidate command in `commands[]` is validated against the baseline CI commands parsed from `.github/workflows/*.yml` during Gather.
   - A command is **allowed** only if it uses the **same tool and subcommand** as a workflow command (e.g., `vitest run`, `jest`, `pytest`, `eslint`, `ruff check`, `tsc --noEmit`, `npm test`, `npm run <script>`) and only narrows scope via safe file paths or test-name filters inside the repository.
   - Any command containing arbitrary shell chaining (`;`, `&&`, `||`, `|`, `` ` ``, `$()`), redirection (`>`, `<`), path traversal (`..`), or binaries/subcommands absent from `.github/workflows/*.yml` is **refused and logged**.
2. **Timeouts & Resource Limits:**
   - Each command runs with a configurable per-command timeout (e.g., 60s default) and bounded stdout/stderr capture.
3. **Exit-Code-Only Verdict:**
   - Each executed command records `command`, `status` (`passed` | `failed` | `timed_out` | `refused`), `exit_code`, `duration_ms`, and a failure output excerpt.
   - The overall Verify result is determined **solely from the exit codes of executed commands**:
     - Exit code `0` across all executed checks → `"these checks passed"`
     - Any non-zero exit code or timeout → `"these checks failed"`
   - Preflight never reports `"CI will pass"`.

### Stage 4: Explain (`preflight explain <CI log URL or file>`)

Fast post-failure diagnosis and verified patch suggestion:

1. **Input:** Accepts either a GitHub Actions run/job URL (fetched via `gh` CLI / GitHub API) or a path to a local CI log file, combined with the local git diff and `.github/workflows/*.yml`.
2. **Diagnosis Call:** Sends the trimmed failure log excerpt + diff to Kimi K3.1 Pro on Cerebras (single call, `<= 20K` input tokens, plain-text JSON output) to produce:
   - `root_cause`: exact file, symbol/line, and explanation of why the diff triggered the CI failure.
   - `failing_command`: the workflow command that failed.
   - `suggested_patch`: minimal unified diff or concrete code change to resolve the failure.
3. **Local Verification (When Possible):** When the local repo state and allowlisted `failing_command` permit, re-runs the failing command to confirm the failure and/or verify whether the suggested patch resolves it.

---

## 3. Product Surfaces

### 3.1 CLI (`preflight`)

Built on TypeScript + Node 22 (`>=22`).

| Command | Description |
| :--- | :--- |
| `preflight check [options]` | Run the `Gather → Think → Verify` pipeline on the current working tree / branch diff and print check verdicts + Speed panel. |
| `preflight explain <log-url-or-file> [options]` | Diagnose a failed CI run log against the repository diff, output root cause + suggested patch, and verify locally when possible. |
| `preflight bench [options]` | Run the benchmark evaluation suite across `bench/cases/*.json` and output accuracy + latency metrics. |

**Global CLI Flags:**

- `--provider <cerebras|gpu>`: Select inference provider (`cerebras` by default using `moonshotai-kimi-k3.1-pro-trial`; `gpu` / `moonshot` uses Moonshot's standard GPU-backed Kimi API for side-by-side latency comparison).
- `--json`: Emit machine-readable JSON output containing stage results, command exit codes, Think payload, and Speed panel telemetry.
- `--think`: Opt-in to enable model reasoning (`reasoning_effort`) during the Think / Explain call.
- `--help`, `-h`: Display CLI usage information.

### 3.2 OpenClaw Harness Integration

Preflight is designed to run inside the **OpenClaw** coding agent inner loop configured with `@openclaw/cerebras-provider` (`moonshotai-kimi-k3.1-pro-trial` via `CEREBRAS_API_KEY`):

1. **Preferred Mechanism — OpenClaw Tool / Skill Registration:**
   - Register Preflight as a native OpenClaw skill/tool that invokes `preflight check --json` and returns the structured JSON report directly to the OpenClaw agent before committing, pushing, or opening a PR.
2. **Fallback Mechanism — Direct Shell Invocation:**
   - If skill/tool registration encounters harness friction, the OpenClaw agent invokes `preflight check --json` via its built-in shell execution tool as a pre-push gate.

### 3.3 Speed Panel Telemetry

Every human-readable CLI execution displays a **Speed Panel** (and `--json` includes the equivalent structured `telemetry` object) highlighting Cerebras wafer-scale inference speed vs local verification time:

- **Token Usage:**
  - Input tokens (`usage.prompt_tokens`)
  - Output tokens (`usage.completion_tokens`)
  - Total tokens (`usage.total_tokens`)
- **Inference Throughput:**
  - `tok/s`: Calculated from Cerebras server timing as `usage.completion_tokens / time_info.completion_time` (or client wall-clock completion tokens/sec when `time_info` is unavailable on `--provider gpu`).
- **Cerebras `time_info` Breakdown (4 fields):**
  - `queue_time` (seconds)
  - `prompt_time` (seconds)
  - `completion_time` (seconds)
  - `total_time` (seconds)
- **End-to-End Stage Wall Time Split:**
  - `gather_ms`: Local git diff, import graph, and workflow parsing duration
  - `think_ms`: End-to-end HTTP call duration for Kimi inference
  - `verify_ms`: Local command execution duration
  - `total_wall_ms`: Overall wall-clock runtime

### 3.4 `--provider` GPU Provider Comparison

Running `preflight check --provider cerebras` vs `preflight check --provider gpu` (or running `preflight bench` across both providers) sends the identical prompt to:

- **Cerebras (`cerebras`):** `https://api.cerebras.ai/v1` (`moonshotai-kimi-k3.1-pro-trial`)
- **Standard GPU Provider (`gpu`):** Moonshot Kimi OpenAI-compatible API (`https://api.moonshot.ai/v1`)

This demonstrates why wafer-scale inference matters in an interactive coding-agent pre-check loop: multi-second Think latency on traditional GPU endpoints turns pre-checks into friction, whereas sub-second/low-second Cerebras Think latency disappears into the agent loop.

---

## 4. Non-Goals

To keep scope disciplined for the weekend hackathon and preserve the core trust invariant, Preflight explicitly **does not** include:

1. **No PR Review Bot:** Not a GitHub webhook comment bot that posts generic code review comments on PRs.
2. **No GitHub App:** No hosted multi-tenant GitHub App, OAuth installation flow, or database backend.
3. **No Web Dashboard (Unless Time Remains):** CLI + OpenClaw terminal workflow is primary; a web UI is strictly out of scope unless all core features, benchmarks, and the 60s video are completely finished.
4. **Never Claim "Passes CI":** Preflight only runs scoped local checks and reports `"these checks passed / these checks failed"`. It never claims full remote CI will pass (since remote CI may involve secrets, multi-OS matrices, external services, or unrun jobs).

---

## 5. Benchmark Specification (`bench/`)

Preflight evaluates triage quality, root-cause diagnosis, false-alarm rate, and speed on a curated dataset of real public GitHub pull requests stored in `bench/cases/*.json` and documented in `bench/README.md`.

### 5.1 Dataset Composition

- **20–30 Failed-CI PRs (`fail-*.json`):**
  - Sourced from small, clean public JavaScript/TypeScript or Python repositories using GitHub Actions (`.github/workflows/*.yml`) with fast local test suites (`< 2 minutes` to install and run locally).
  - Every failed PR must have a **clear root cause directly in the changed code** (unit test failure, typecheck error, lint violation, or assertion failure caused by the PR diff).
  - **Excluded:** CI infrastructure outages, missing secrets/permissions, flaky unrelated tests, or noisy dependency-bump PRs.
- **~10 Passing-CI PRs (`pass-*.json`):**
  - Sourced from the same repositories where CI checks passed on `head_sha`, used to measure false-alarm behaviour and check scoping overhead.

### 5.2 Per-Case JSON Schema

Each file in `bench/cases/<id>.json` conforms to:

```json
{
  "id": "fail-01-owner-repo-pr-123",
  "status": "fail",
  "repo": "owner/name",
  "pr": 123,
  "pr_url": "https://github.com/owner/name/pull/123",
  "language": "typescript",
  "base_sha": "0123456789abcdef0123456789abcdef01234567",
  "head_sha": "89abcdef0123456789abcdef0123456789abcdef",
  "workflow_file": ".github/workflows/ci.yml",
  "run_id": 123456789,
  "run_url": "https://github.com/owner/name/actions/runs/123456789",
  "failing_job": "test",
  "failing_command": "npm test",
  "log_excerpt": "Verbatim 10-40 line excerpt from the failed GitHub Actions job log...",
  "changed_files": ["src/index.ts"],
  "root_cause_label": "src/index.ts: parseConfig throws TypeError on undefined options argument",
  "label_verified": {
    "checked_against_log": true,
    "checked_against_diff": true,
    "notes": "Confirmed diff in src/index.ts removed default parameter value matching TypeError in test log"
  }
}
```

*(For passing cases: `"status": "pass"`, `"failing_job": null`, `"failing_command": null`, `"log_excerpt": null`, and `"root_cause_label": "passing: <short description>"`.)*

### 5.3 Benchmark Metrics

1. **Command / Job Selection Recall:** Fraction of failed-CI cases where Think's `affected_jobs[]` and allowlisted `commands[]` include the actual failing job/command (or a narrower scoped command covering the failing test/file).
2. **Local Reproduction & Catch Rate:** On locally checked-out benchmark cases, fraction where executing Verify's selected commands catches the non-zero exit code before push.
3. **Passing-PR Precision / False-Alarm Rate:** On passing-CI cases (when reproduced locally), fraction where Verify executes cleanly without false failures while running a scoped subset of checks.
4. **Root-Cause Explanation Accuracy:** Fraction of failed-CI cases where `preflight explain` identifies the same root-cause file/symbol/defect as `root_cause_label`.
5. **Speed & Throughput Telemetry:** Median and p95 `tok/s`, `think_ms`, `time_info.completion_time`, and total wall time on Cerebras vs `--provider gpu`.

### 5.4 Benchmark Honesty Rule

- Every case label in `bench/cases/` must be verified against **both** the actual GitHub Actions failure log and the exact commit diff (`base_sha..head_sha` at the time CI failed, even if the PR was later amended and merged).
- At least 2 failed-CI benchmark cases are reproduced end-to-end locally during Phase 0 groundwork to validate local test execution feasibility.
- Never fabricate, extrapolate, or cherry-pick benchmark numbers. Always report exact denominators and distinguish static diff+log evaluation across all cases from full local checkout command execution.

---

## 6. Platform Facts & Operational Limits

| Parameter | Specification |
| :--- | :--- |
| **Cerebras Base URL** | `https://api.cerebras.ai/v1` (OpenAI-compatible `POST /chat/completions`) |
| **Cerebras Auth Env Var** | `CEREBRAS_API_KEY` (`Authorization: Bearer <key>`) |
| **Cerebras Model ID** | `moonshotai-kimi-k3.1-pro-trial` |
| **Rate Limits** | **100 requests / minute** and **100,000 tokens / minute** |
| **Concurrency** | **Single-flight (`concurrency = 1`)** per process via an internal mutex queue |
| **Pre-Charged Completion Quota** | Cerebras pre-charges the full `max_completion_tokens` value against the 100K tok/min limit when a request starts. Keep `max_completion_tokens` at **`~1,500`** (`<= 2,000`). |
| **Input Context Budget** | **`<= 20,000` input tokens** per call via deterministic priority trimming |
| **HTTP 429 Handling** | Honor `Retry-After` header when present; otherwise bounded exponential backoff with random jitter |
| **Reasoning Mode** | Off by default (`reasoning_effort` omitted). Exact `reasoning_effort` values supported by `moonshotai-kimi-k3.1-pro-trial` to be verified at kickoff (Sat Nov 21, 10:00 AM PT) for the `--think` flag. |
| **Structured Outputs / Tool Calling** | Do **not** depend on API `tools` or `response_format: json_schema`. Use plain-text JSON prompts + local schema validation + 1 retry. |
| **SSE Streaming Caveat** | Cerebras SSE streams can pack multiple tokens into a single SSE chunk; always use `usage` + `time_info` from the API response for token/s calculation rather than counting SSE events. |
| **GPU Comparison Provider** | Moonshot Kimi API (`https://api.moonshot.ai/v1`, `MOONSHOT_API_KEY`, configurable `MOONSHOT_MODEL`). Measures client wall-clock time since `time_info` is Cerebras-specific. |

---

## 7. Hackathon Rules, Submission Requirements & Storyboard

### 7.1 Time Gate & Phase 0 Boundary

- **Kickoff Time Gate:** **Saturday, Nov 21, 2026 at 10:00 AM PT**.
- **Phase 0 Allowed Work (Before Kickoff):**
  - Architecture and specification docs (`docs/SPEC.md`, `docs/DECISIONS.md`, `docs/notes/*.md`)
  - Empty project scaffolding, build/lint/test setup, CI workflow, stub CLI printing `not implemented`, and thin HTTP API client wrappers (`src/clients/*`)
  - Benchmark dataset curation and local reproduction verification (`bench/cases/*.json`, `bench/README.md`)
- **Forbidden Before Kickoff:** Writing any Gather, Think, Verify, or Explain business logic before Sat Nov 21, 10:00 AM PT.

### 7.2 Submission Requirements

1. **X (Twitter) Post:**
   - Public post featuring a **<= 60-second demo video**.
   - Tag/mention required organizers and partners (`@CerebrasSystems`, `@Kimi_Moonshot`, `@OpenClawAI` / official hackathon hashtag).
   - Include link to the public GitHub repository.
2. **Optional Reddit Cross-Post:**
   - Share the demo and benchmark write-up on relevant developer communities (e.g., `r/LocalLLaMA`) if time permits.

### 7.3 60-Second Demo Video Storyboard

| Time | Beat | On-Screen Visual | Narration / Caption Focus |
| :--- | :--- | :--- | :--- |
| **0:00–0:08** | **Hook & Problem** | Split screen: AI agent blind-pushing a PR vs GitHub Actions failing 4 minutes later on a broken import/test. | "AI coding agents write code in seconds—then wait minutes for GitHub Actions to fail. What if your agent ran the right CI checks locally in two seconds?" |
| **0:08–0:25** | **Live OpenClaw + Preflight Check** | OpenClaw agent edits code, triggers `preflight check`. Gather → Think (Kimi K3.1 Pro on Cerebras) → Verify runs scoped Vitest & `tsc` command, catches real failure with non-zero exit code. | "Meet Preflight. Inside OpenClaw, Kimi K3.1 Pro on Cerebras inspects the git diff and workflow files, selects only the affected checks, and runs the real commands locally." |
| **0:25–0:38** | **Explain & Fix Loop** | Run `preflight explain` (or agent applies fix and re-runs `preflight check`). Scoped checks turn green with exit code 0. | "Kimi pinpoints the root cause, the agent patches it, and Preflight verifies the fix via real exit codes—never guessing." |
| **0:38–0:50** | **Cerebras vs GPU Speed Panel** | Side-by-side terminal race: `--provider cerebras` vs `--provider gpu`, highlighting Speed Panel (`tok/s`, `time_info.completion_time`, wall time split). | "Why Cerebras? On a standard GPU endpoint, the Think step stalls the inner loop. On Cerebras, Kimi K3.1 Pro triages the diff in a fraction of a second." |
| **0:50–1:00** | **Benchmark Proof & CTA** | Benchmark table across 20–30 failed + ~10 passing real GitHub PRs, followed by GitHub repo URL and tags. | "Tested on over 30 real GitHub PRs. Open source today—try Preflight with OpenClaw and Kimi K3.1 Pro on Cerebras." |

### 7.4 Scope Cut Order

If schedule pressure arises during the weekend, features are cut in strict reverse priority order (from first-to-cut to never-cut):

1. **Cut 1 (First to Cut):** Any optional web UI / dashboard polish (keep 100% terminal CLI + OpenClaw).
2. **Cut 2:** Auto-applying patches inside `preflight explain` (keep root-cause diagnosis + printed suggested patch + re-running the failing command).
3. **Cut 3:** Deep multi-hop transitive import-graph resolution for complex monorepos (fall back to 1-hop direct import matching + directory/filename heuristics + workflow commands).
4. **Cut 4:** Native OpenClaw plugin/skill packaging if harness quirks block it (fall back immediately to OpenClaw invoking `preflight check --json` via shell tool).
5. **Never Cut (Core Must-Haves):**
   - `preflight check` end-to-end (`Gather → Think → Verify`) with strict workflow allowlist and exit-code-only verdicts
   - Speed panel with real Cerebras `time_info` and `--provider` GPU comparison
   - `preflight explain` on real CI failure logs
   - Honest benchmark results on `bench/cases/` and the <= 60s demo video
