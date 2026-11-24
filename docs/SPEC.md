# Preflight — Technical Specification

> **Local-first, $0 CI pre-checks and failure diagnosis for developers and AI coding agents.**  
> Standalone MIT-licensed open-source CLI and portable Agent Skill (`https://github.com/OmChauhan9/preflight`).

---

## 1. Product Summary & Core Invariant

AI coding agents and developers iterate quickly in a local repository, commit or open a pull request, and then wait minutes for GitHub Actions CI to fail on a scoped test, typecheck, or lint error caused directly by their diff. Running the entire CI suite locally after every edit is too slow; skipping checks entirely leads to broken PRs.

**Preflight** closes this feedback loop in seconds at **$0 cost**. Before a developer or coding agent pushes code or opens a PR, Preflight inspects the local `git diff`, static import graph, and `.github/workflows/*.yml` definitions, asks a configured OpenAI-compatible LLM (defaulting to local **Ollama** with `qwen2.5-coder:7b`) which CI jobs and scoped commands are most likely affected by the change, executes only those safe, workflow-derived commands locally, and reports the actual command results and latency telemetry. When CI has already failed remotely, `preflight explain` diagnoses the failure log against the diff, proposes a minimal fix, and verifies it locally when possible.

### Core Invariant

> **An LLM decides *what* to check from the `git diff`, import graph, and `.github/workflows/*.yml`; real allowlisted scoped CI commands decide pass or fail via actual subprocess exit codes. Preflight never claims "CI will pass" — only "these checks passed" or "these checks failed".**

- The LLM is used strictly for **triage, scoping, and root-cause explanation**: mapping a code diff and workflow definition to the highest-signal subset of checks, or diagnosing a failure log.
- Pass/fail verdicts come **100% from real subprocess exit codes** of allowlisted commands executed in the repository.
- Preflight output always states **"these checks passed / these checks failed"** (along with exact commands and exit codes) and never promises that full remote CI will pass.

---

## 2. Pipeline Architecture & Stages

Preflight operates as a four-stage pipeline (`Gather → Think → Verify`, plus on-demand `Explain`):

```text
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
│ 2. THINK (Single LLM Call via OpenAICompatibleClient)                   │
│    • Default preset: ollama (http://localhost:11434/v1,                 │
│      model qwen2.5-coder:7b, $0 local-first, concurrency = 1)           │
│    • Built-in presets: ollama, groq, gemini, openrouter,                │
│      openai, cerebras, custom                                           │
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
│    • Single LLM call → root cause + minimal suggested patch             │
│    • Re-run the failing command locally when possible to verify fix     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Stage 1: Gather (Plain Code)

Deterministic, zero-LLM local context collection:

1. **Git Diff & Changed Files:** Runs `git diff` against the target base branch (or merge-base) to collect changed file paths, change statuses, and unified diff hunks.
2. **Import Graph & Affected Tests:** Parses local JS/TS (`import`/`require`) and Python (`import`/`from ... import`) dependencies to identify test files that directly or transitively import modified source modules.
3. **Workflow Command Extraction:** Parses `.github/workflows/*.yml` (and `.yaml`) files to extract job names, working directories, matrix hints, and `run:` shell steps (e.g., `npm test`, `npx vitest run`, `npm run typecheck`, `npm run lint`, `pytest`, `ruff check`, `mypy`).
4. **Optional Recent CI Log:** If provided or available from recent failure state, attaches a bounded failure log excerpt.
5. **Context Budgeting:** Priority-trims gathered context to guarantee the prompt stays within **`<= 20,000` input tokens** using the 5-tier priority order:
   1. `(1) git diff`
   2. `(2) CI commands`
   3. `(3) changed files' tests`
   4. `(4) changed files`
   5. `(5) neighbors`
   Trimming proceeds in reverse priority order (dropping/truncating `(5) neighbors` first, then `(4) changed files`, etc.; see Section 6).

### Stage 2: Think (Single OpenAI-Compatible LLM Call)

A single inference call executed through `OpenAICompatibleClient` (`POST {baseUrl}/chat/completions`):

- **Token Budget:** `<= 20,000` input tokens; `max_completion_tokens` capped at **`~1,500`** so outputs remain concise and fit comfortably within local model context budgets and cloud free-tier rate limits.
- **Reasoning Mode:** Off by default (and enabled explicitly via `--think`) so latency stays low and completions are not truncated by long chain-of-thought traces.
- **Plain-Text JSON Contract:** Preflight does not depend on provider-specific tool calling (`tools`) or structured-output modes (`response_format: { type: "json_schema" }`), ensuring uniform behavior across local Ollama models and cloud endpoints. Instead, the system prompt specifies a strict plain-text JSON contract:

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
  - Extract the JSON object from the completion text (stripping optional markdown code fences if present) and validate all required fields and types against the schema.
  - If JSON parsing or schema validation fails, perform **at most 1 retry**, passing the exact validation error message back to the model.
  - If the retry also fails validation, abort the Think stage with a clear, structured error message rather than looping or silently guessing.

### Stage 3: Verify (Plain Code)

Safe, deterministic local command execution:

1. **Workflow-Derived Allowlist:**
   - Every candidate command in `commands[]` is validated against the baseline CI commands parsed from `.github/workflows/*.yml` during Gather.
   - A command is **allowed** only if it uses the **same tool and subcommand** as a workflow command (e.g., `vitest run`, `mocha`, `jest`, `pytest`, `eslint`, `ruff check`, `tsc --noEmit`, `npm test`, `npm run <script>`) and only narrows scope via safe file paths or test-name filters inside the repository.
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

1. **Input:** Accepts either a GitHub Actions run/job URL (fetched via `gh` CLI / GitHub API) or a path to a local CI log file, combined with the local `git diff` and `.github/workflows/*.yml`.
2. **Diagnosis Call:** Sends the trimmed failure log excerpt + diff to the configured LLM via `OpenAICompatibleClient` (single call, `<= 20K` input tokens, plain-text JSON output + 1 retry on schema error) to produce:
   - `root_cause`: exact file, symbol/line, and explanation of why the diff triggered the CI failure.
   - `failing_command`: the workflow command that failed.
   - `suggested_patch`: minimal unified diff or concrete code change to resolve the failure.
3. **Local Verification (When Possible):** When the local repo state and allowlisted `failing_command` permit, re-runs the failing command to confirm the failure and/or verify whether the suggested patch resolves it.

---

## 3. Product Surfaces

### 3.1 Standalone CLI (`preflight`)

Built on TypeScript + Node 22 (`>=22`). *(Implementation status note: In the current v0.1.0 Phase 0 scaffold (`src/cli.ts`), `preflight check`, `preflight explain`, and `preflight bench` parse flags and print `not implemented` with exit code `0`; full stage execution lands in Phases 1–2.)*

| Command | Description |
| :--- | :--- |
| `preflight check [options]` | Run the `Gather → Think → Verify` pipeline on the current working tree / branch diff and print check verdicts + Speed/Telemetry panel *(currently a `not implemented` stub exiting `0` in v0.1.0)*. |
| `preflight explain <log-url-or-file> [options]` | Diagnose a failed CI run log against the repository diff, output root cause + suggested patch, and verify locally when possible *(currently a `not implemented` stub exiting `0` in v0.1.0)*. |
| `preflight bench [options]` | Run the benchmark evaluation suite across `bench/cases/*.json` and output accuracy + latency metrics *(currently a `not implemented` stub exiting `0` in v0.1.0)*. |
| `preflight init --hook` *(Planned in Phase 1)* | Install an optional local `.git/hooks/pre-push` hook that runs `preflight check` before pushing commits to a remote. |

**Global CLI Flags:**

- `--provider <ollama|groq|gemini|openrouter|openai|cerebras|custom>`: Select the OpenAI-compatible inference provider preset (defaults to `ollama` or `PREFLIGHT_PROVIDER`).
- `--model <model-id>`: Override the model identifier for the selected provider (or set `PREFLIGHT_MODEL`).
- `--json`: Emit machine-readable JSON output containing stage results, command exit codes, Think payload, and Speed/Telemetry metrics.
- `--think`: Opt in to enable model reasoning during the Think / Explain call.
- `--help`, `-h`: Display CLI usage information.

### 3.2 Generic Agent Skill (`skills/preflight/SKILL.md` & `docs/agent-setup.md`)

Preflight packages a cross-platform Agent Skill adhering to the open [Agent Skills specification](https://agentskills.io/specification) (`skills/preflight/SKILL.md`, documented in [`docs/agent-setup.md`](./agent-setup.md) and [`docs/notes/agent-integrations.md`](./notes/agent-integrations.md)):

1. **Supported Coding Agents:**
   - **Claude Code** (`.claude/skills/preflight/SKILL.md`)
   - **OpenAI Codex** (`.codex/skills/preflight/SKILL.md` or `.agents/skills/preflight/SKILL.md`)
   - **Cursor** (`.cursor/skills/preflight/SKILL.md` or `.agents/skills/preflight/SKILL.md`)
   - **OpenClaw** (`<workspace>/skills/preflight/SKILL.md` or `~/.openclaw/skills/preflight/SKILL.md`)
   - **Antigravity** (`.agent/skills/preflight/SKILL.md`)
2. **Fallback Mechanism — Direct Shell Invocation:**
   - Any coding agent, IDE task runner, or automation script can invoke `preflight check --json` and `preflight explain <log> --json` directly via a standard shell tool without skill registration.

### 3.3 Optional Git `pre-push` Hook (`preflight init --hook`, Planned in Phase 1)

For developers and agent workflows that want automatic enforcement on every `git push` without manual agent prompting:

- `preflight init --hook` installs a lightweight `.git/hooks/pre-push` script.
- On `git push`, the hook invokes `preflight check` against the commits being pushed.
- If all allowlisted checks exit with `0`, the push proceeds normally; if any executed check fails with a non-zero exit code, the push is aborted with a diagnostic report (and can be bypassed explicitly with `git push --no-verify` when needed).

### 3.4 Speed & Telemetry Panel

Every human-readable CLI execution displays a **Speed & Telemetry Panel** (and `--json` includes the equivalent structured `telemetry` object) so users can compare local models and cloud providers:

- **Provider & Model Metadata:**
  - `provider` preset name, resolved `model` ID, and endpoint base URL.
- **Token Usage (`usage`):**
  - Input tokens (`usage.prompt_tokens`)
  - Output tokens (`usage.completion_tokens`)
  - Total tokens (`usage.total_tokens`)
- **Inference Throughput (`tok/s`):**
  - Calculated from server timing as `usage.completion_tokens / time_info.completion_time` when the provider returns `time_info` (e.g., Cerebras), or from client-measured `wallTimeMs` (`usage.completion_tokens / (wallTimeMs / 1000)`) across Ollama, Groq, Gemini, OpenRouter, OpenAI, and custom endpoints.
- **Optional Provider `time_info` Breakdown (when returned by provider):**
  - `queue_time`, `prompt_time`, `completion_time`, `total_time` (in seconds).
- **End-to-End Stage Wall Time Split:**
  - `gather_ms`: Local `git diff`, import graph, and workflow parsing duration
  - `think_ms`: End-to-end HTTP call duration (`wallTimeMs`) for LLM inference
  - `verify_ms`: Local command execution duration
  - `total_wall_ms`: Overall wall-clock runtime

---

## 4. Non-Goals

To keep Preflight fast, trustworthy, and **$0** to run, the project explicitly **does not** include:

1. **No PR Review Bot:** Not a GitHub webhook comment bot that posts generic prose review comments on pull requests.
2. **No Hosted GitHub App or Paid SaaS Backend:** No multi-tenant cloud service, OAuth installation flow, or database backend. Preflight runs 100% locally in your working tree or CLI environment at $0 infrastructure cost.
3. **No Web Dashboard:** Preflight is purpose-built for terminal workflows, git hooks, and AI coding agents via CLI and `--json`.
4. **Never Claim "CI Will Pass":** Preflight only runs scoped local checks and reports `"these checks passed / these checks failed"`. It never claims full remote CI will pass (since remote CI may involve deployment secrets, multi-OS matrices, external service containers, or unrun jobs).

---

## 5. Benchmark Specification (`bench/`)

Preflight evaluates triage quality, root-cause diagnosis, false-alarm rate, and inference latency on a curated dataset of real public GitHub pull requests stored in `bench/cases/*.json` and documented in [`bench/README.md`](../bench/README.md) and [`bench/REPRO.md`](../bench/REPRO.md).

### 5.1 Verified Dataset Composition (35 Real GitHub PRs)

The benchmark corpus in `bench/cases/` comprises **35 hand-verified GitHub Pull Request CI runs** across **10 open-source JavaScript/TypeScript and Python repositories** (`expressjs/express`, `colinhacks/zod`, `unjs/h3`, `fastify/fastify`, `axios/axios`, `pallets/werkzeug`, `pallets/jinja`, `pallets/click`, `encode/httpx`, and `pydantic/pydantic-settings`):

- **25 Failed-CI PRs (`fail-01` .. `fail-25`):**
  - **14 JavaScript/TypeScript cases** (9 failed, 5 passing) and **21 Python cases** (16 failed, 5 passing) overall.
  - Across the 25 failed cases: **13 unit test failures** (`unit_test`), **5 typecheck failures** (`typecheck`), and **7 lint/format failures** (`lint_format`).
  - Every failed PR has a **clear root cause directly in the changed code** verified against both the GitHub Actions failure log and the commit diff (`base_sha..head_sha`).
  - **Excluded (12 raw candidates rejected during curation):** CI runner provisioning outages, upstream packaging/bundler drift unrelated to the PR diff, flaky timing warnings, and spam/duplicate formatting PRs (documented in [`bench/README.md`](../bench/README.md)).
- **10 Passing-CI PRs (`pass-01` .. `pass-10`):**
  - One passing PR from each of the 10 repositories where CI checks passed on `head_sha`, used to measure false-alarm behavior and check scoping precision.
- **2 Locally Reproduced `<1s` Anchor Cases ([`bench/REPRO.md`](../bench/REPRO.md)):**
  - `fail-01-express-pr-7531` (`expressjs/express#7531`): `npx mocha test/app.listRoutes.js` reproduces exit code `9` in **`0.84s`** command wall time.
  - `fail-10-werkzeug-pr-3269` (`pallets/werkzeug#3269`): `pytest tests/sansio/test_accept_mimetype_cases.py` reproduces exit code `1` in **`0.80s`** command wall time.

### 5.2 Per-Case JSON Schema

Each file in `bench/cases/<id>.json` conforms to:

```json
{
  "id": "fail-01-express-pr-7531",
  "status": "fail",
  "repo": "expressjs/express",
  "pr": 7531,
  "pr_url": "https://github.com/expressjs/express/pull/7531",
  "language": "javascript",
  "base_sha": "0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8",
  "head_sha": "5ebf19adabb6e0741eda1fecadecee9f6543ba49",
  "workflow_file": ".github/workflows/ci.yml",
  "run_id": 44581270820,
  "run_url": "https://github.com/expressjs/express/actions/runs/44581270820",
  "failing_job": "Node.js 18 - ubuntu-latest",
  "failing_command": "npm run test-ci",
  "log_excerpt": "Verbatim 10-40 line excerpt from the failed GitHub Actions job log...",
  "changed_files": ["lib/application.js", "package.json", "test/app.listRoutes.js"],
  "root_cause_label": "unit_test: lib/application.js mount/listRoutes sub-app router handling causes 9 test failures in test/app.listRoutes.js",
  "label_verified": {
    "checked_against_log": true,
    "checked_against_diff": true,
    "notes": "Verified 9 Mocha failures in test/app.listRoutes.js directly match changes to lib/application.js and test/app.listRoutes.js in diff"
  }
}
```

*(For passing cases: `"status": "pass"`, `"failing_job": null`, `"failing_command": null`, `"log_excerpt": null`, and `"root_cause_label": "passing: <short description>"`.)*

### 5.3 Benchmark Metrics

1. **Command / Job Selection Recall:** Fraction of failed-CI cases where Think's `affected_jobs[]` and allowlisted `commands[]` include the actual failing job/command (or a narrower scoped command covering the failing test/file).
2. **Local Reproduction & Catch Rate:** On locally checked-out benchmark cases, fraction where executing Verify's selected commands catches the non-zero exit code before push.
3. **Passing-PR Precision / False-Alarm Rate:** On passing-CI cases (when reproduced locally), fraction where Verify executes cleanly without false failures while running a scoped subset of checks.
4. **Root-Cause Explanation Accuracy:** Fraction of failed-CI cases where `preflight explain` identifies the same root-cause file/symbol/defect as `root_cause_label`.
5. **Speed & Throughput Telemetry:** Median and p95 `tok/s`, `think_ms`, optional `time_info.completion_time`, and total wall time across configured providers (`--provider ollama`, `groq`, `gemini`, `openrouter`, `openai`, `cerebras`, etc.).

### 5.4 Benchmark Honesty Rule

- Every case label in `bench/cases/` is verified against **both** the actual GitHub Actions failure log and the exact commit diff (`base_sha..head_sha` at the time CI failed, even if the PR was later amended and merged).
- Two failed-CI benchmark cases (`fail-01-express-pr-7531` and `fail-10-werkzeug-pr-3269`) have been reproduced end-to-end locally in [`bench/REPRO.md`](../bench/REPRO.md) to validate `<1s` scoped command execution.
- Never fabricate, extrapolate, or cherry-pick benchmark numbers. Live benchmark scores will be reported only after `preflight bench` runs against the completed Phase 1–2 pipeline, always stating exact denominators and distinguishing static diff+log evaluation across all 35 cases from full local checkout command execution.

---

## 6. Provider Architecture & Operational Limits

Preflight talks to all inference backends through a single `OpenAICompatibleClient` targeting `POST {baseUrl}/chat/completions`.

### 6.1 Built-In Provider Presets

| Preset | Default Base URL | Default Model | Provider API Key Env Var | Default Auth Requirement |
| :--- | :--- | :--- | :--- | :--- |
| **`ollama`** *(default)* | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | `OLLAMA_API_KEY` *(optional)* | None ($0 local daemon; `Authorization` header omitted unless `PREFLIGHT_API_KEY`, `OLLAMA_API_KEY`, or `options.apiKey` is set) |
| **`groq`** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Required (`Bearer <key>`) |
| **`gemini`** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | `GEMINI_API_KEY` | Required (`Bearer <key>`) |
| **`openrouter`** | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-coder-32b-instruct:free` | `OPENROUTER_API_KEY` | Required (`Bearer <key>`) |
| **`openai`** | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` | Required (`Bearer <key>`) |
| **`cerebras`** | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | Required (`Bearer <key>`) |
| **`custom`** | `PREFLIGHT_BASE_URL` | `PREFLIGHT_MODEL` | `PREFLIGHT_API_KEY` | Optional (`Bearer <key>` when set) |

### 6.2 Configuration & Operational Safeguards

| Parameter | Specification |
| :--- | :--- |
| **Config Precedence** | CLI flags (`--provider`, `--model`) → generic env vars (`PREFLIGHT_PROVIDER`, `PREFLIGHT_MODEL`, `PREFLIGHT_BASE_URL`, `PREFLIGHT_API_KEY`) → provider-specific env vars (`OLLAMA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`) → preset defaults (`ollama`, `qwen2.5-coder:7b`, `http://localhost:11434/v1`). |
| **Concurrency** | **Single-flight (`concurrency = 1`)** per process via an internal FIFO mutex queue so sequential or benchmark calls never flood local hardware or free-tier cloud rate limits. |
| **Input Context Budget** | **`<= 20,000` input tokens** per call via deterministic priority trimming in 5-item order: (1) `git diff`, (2) CI commands, (3) changed files' tests, (4) changed files, (5) neighbors — trimmed in reverse priority order. |
| **Output Token Cap** | **`max_completion_tokens: ~1,500`** (`<= 2,000`), preventing runaway completions and respecting providers that pre-charge `max_completion_tokens` against per-minute token quotas. |
| **HTTP 429 Handling** | Honor `Retry-After` response header (delta-seconds or HTTP-date) when present; otherwise bounded exponential backoff with random jitter. |
| **Secret Redaction** | API keys are read strictly from environment variables and redacted (`[REDACTED]`) from all error messages, stack traces, and debug logs. |
| **Structured Outputs / Tool Calling** | Do **not** depend on provider-specific `tools` or `response_format: json_schema`. Use plain-text JSON prompts + local schema validation + at most 1 retry. |
| **Timing & Telemetry** | Always record client-side `wallTimeMs` (`performance.now()`) plus `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`), and capture optional provider `time_info` (`queue_time`, `prompt_time`, `completion_time`, `total_time`) when present in the JSON response. |

---

## 7. Project Roadmap & Phased Delivery

1. **Phase 0 — Groundwork, Open-Source Pivot & Verified Benchmark Corpus (Complete):**
   - Architecture and technical specification (`docs/SPEC.md`, `docs/DECISIONS.md`, `docs/notes/providers.md`, `docs/notes/agent-integrations.md`).
   - Provider-agnostic `OpenAICompatibleClient` (`src/clients/`) supporting `ollama` ($0 local default), `groq`, `gemini`, `openrouter`, `openai`, `cerebras`, and `custom`.
   - CLI entry point (`src/cli.ts`, with `check`, `explain`, and `bench` wired as `not implemented` stubs exiting `0`), portable Agent Skill (`skills/preflight/SKILL.md`, `docs/agent-setup.md`), and unit test suite.
   - Curated 35-case real GitHub PR benchmark corpus (`bench/cases/*.json`, `bench/README.md`) with 2 local `<1s` reproductions (`bench/REPRO.md`).
2. **Phase 1 — Core `Gather → Think → Verify` & `Explain` Pipeline (Next):**
   - Implement `Gather` (git diff parser, JS/TS & Python static import graph, `.github/workflows/*.yml` command extractor, and 5-tier token trimmer).
   - Implement `Think` (prompt builder, plain-text JSON extractor, schema validator, and 1-retry self-correction loop).
   - Implement `Verify` (workflow-derived command allowlist validator, subprocess runner with timeouts, exit-code verdict reporter, and Speed/Telemetry panel).
   - Implement `Explain` (`preflight explain <CI log URL or file>`) and optional `preflight init --hook` git `pre-push` hook installer.
3. **Phase 2 — Benchmark Runner & Multi-Provider Evaluation (Planned):**
   - Implement `preflight bench` to evaluate command selection recall, passing-PR precision, root-cause explanation accuracy, and latency telemetry across the 35 verified PR cases on local Ollama and cloud OpenAI-compatible providers.
