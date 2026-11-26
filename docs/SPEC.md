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
│    • Optional recent CI failure log excerpt (recent_ci_log)             │
│    • Deterministic priority trimming to <= 20,000 estimated context     │
│      tokens (chars / 4, ~20K prompt tokens)                             │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. THINK (Single LLM Call via OpenAICompatibleClient)                   │
│    • Default preset: ollama (http://localhost:11434/v1,                 │
│      model qwen2.5-coder:7b, $0 local-first, concurrency = 1)           │
│    • Built-in presets: ollama, groq, gemini, openrouter,                │
│      openai, cerebras, custom                                           │
│    • Input: <= 20,000 est. context tokens (~20K) | max_completion: 1,500│
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

1. **Git Diff & Changed Files:** Resolves `git merge-base` against the target base ref and runs `git diff` to collect changed file paths, change statuses, and unified diff hunks without leaking unrelated upstream commits on the base branch.
2. **Import Graph & Affected Tests:** Parses local JS/TS (`import`/`require`) and Python (`import`/`from ... import`) dependencies to identify test files that directly or transitively import modified source modules, blocking symlinks that resolve outside the repository root.
3. **Workflow Command Extraction:** Parses `.github/workflows/*.yml` (and `.yaml`) files to extract job names, working directories, matrix hints, and `run:` shell steps (e.g., `npm test`, `npx vitest run`, `npm run typecheck`, `npm run lint`, `pytest`, `ruff check`, `mypy`), dropping shell builtins such as `cd`.
4. **Optional Recent CI Log (`recent_ci_log`):** When provided via `--log`, attaches a bounded failure log excerpt immediately after `git diff`.
5. **Context Budgeting:** Priority-trims gathered context to guarantee the prompt stays within **`<= 20,000` estimated context tokens** (`chars / 4`, `~20K` prompt tokens) using the 5-tier priority order (plus optional `recent_ci_log` right after `git diff`, with bounded space reserved for `recent_ci_log` and `ci_commands` when an oversized diff overflows):
   1. `(1) git diff` *(plus optional `recent_ci_log`)*
   2. `(2) CI commands`
   3. `(3) changed files' tests`
   4. `(4) changed files`
   5. `(5) neighbors`
   Trimming proceeds in reverse priority order (dropping/truncating `(5) neighbors` first, then `(4) changed files`, etc.; see Section 6).

### Stage 2: Think (Single OpenAI-Compatible LLM Call)

A single inference call executed through `OpenAICompatibleClient` (`POST {baseUrl}/chat/completions`):

- **Token Budget:** `<= 20,000` estimated context tokens (`chars / 4`, `~20K` prompt tokens); `max_completion_tokens` capped at **`~1,500`** so outputs remain concise and fit comfortably within local model context budgets and cloud free-tier rate limits.
- **Reasoning Mode:** Off by default (and enabled explicitly via `--think`) so latency stays low and completions are not truncated by long chain-of-thought traces. When `--think` is enabled, requests include `reasoning_effort: "low"`, and `reasoning_format: "parsed"` is sent **only** on `groq` and `cerebras` (never to strict OpenAI, Google Gemini, Ollama, OpenRouter, or custom endpoints).
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
   - A command is **allowed** only if it uses the **same tool and subcommand** as a workflow command (e.g., `vitest run`, `mocha`, `jest`, `pytest`, `eslint`, `ruff check`, `tsc --noEmit`, `npm test`, `npm run <script>`) and only narrows scope via safe repository-relative file paths or test-name filters inside the repository. Unmodeled tools and runners default to exact-match-only, baseline CI flags are preserved verbatim, Python interpreter binary path swaps and `@args.txt` argfiles are refused, and shell builtins like `cd` are dropped.
   - Any command containing arbitrary shell chaining (`;`, `&&`, `||`, `|`, `` ` ``, `$()`), redirection (`>`, `<`), path traversal (`..`), or binaries/subcommands absent from `.github/workflows/*.yml` is **refused and logged**.
2. **Timeouts, Env Isolation & Resource Limits:**
   - Each command runs with `shell: false`, LLM API keys stripped from the child process environment, a configurable per-command timeout (60s default via `--timeout`), and bounded stdout/stderr tail capture (32 KiB per stream by default).
3. **Exit-Code-Only Verdict:**
   - Each evaluated command in `verify.results[]` records `command`, `status` (`passed` | `failed` | `timed_out` | `refused`), `exitCode` (`number | null`), `durationMs`, `stdout`, `stderr`, plus optional `matchedWorkflowCommand` or `refusalReason` (and refused entries are mirrored in `verify.refusedCommands[]`).
   - The overall Verify result is determined **solely from the exit codes of executed commands**:
     - Exit code `0` across all executed checks → `verdict: "passed"` (`"these checks passed"`)
     - Any non-zero exit code or timeout → `verdict: "failed"` (`"these checks failed"`)
     - Zero allowlisted checks executed (e.g., no changes or no workflow commands) → `verdict: "no_checks_run"` (`"no allowlisted checks were executed"`)
   - Preflight never reports `"CI will pass"`.

### Stage 4: Explain (`preflight explain <CI log URL or file>`)

Fast post-failure diagnosis and verified patch suggestion:

1. **Input:** Accepts either a GitHub Actions run/job URL (fetched via `gh api`; requires the `gh` CLI) or a path to a local CI log file, combined with the local `git diff` and `.github/workflows/*.yml` (falling back gracefully to log-only context when not in a git repository).
2. **Diagnosis Call:** Sends the trimmed failure log excerpt + diff to the configured LLM via `OpenAICompatibleClient` (single call, `<= 20,000` estimated context tokens via `chars / 4`, plain-text JSON output + at most 1 retry on schema error) to produce:
   - `root_cause`: exact file, symbol/line, and explanation of why the diff triggered the CI failure.
   - `failing_command`: the workflow-derived command that failed, or `null` if none can be identified.
   - `suggested_patch`: minimal unified diff or concrete code change to resolve the failure.
   - `explanation`: concise explanation of why the failure occurred and how the suggested patch fixes it.
3. **Local Verification (When Possible):** Unless `--no-verify` is passed, re-runs the allowlisted `failing_command` locally when available to confirm the failure and report real exit-code verification status.

---

## 3. Product Surfaces

### 3.1 Standalone CLI (`preflight`)

Built on TypeScript + Node 22 (`>=22`). All four CLI commands are implemented in `src/cli.ts`:

| Command | Description |
| :--- | :--- |
| `preflight check [options]` | Run the `Gather → Think → Verify` pipeline on the current working tree / branch diff and output exit-code-backed check verdicts + Speed & Telemetry panel. Exits `0` (`passed` or `no_checks_run`) or `1` (`failed` / error). |
| `preflight explain <log-url-or-file> [options]` | Diagnose a failed CI run log (local file or GitHub Actions run/job URL) against the repository diff, output root cause + failing command + suggested patch + explanation, and verify locally unless `--no-verify` is passed. |
| `preflight init --hook [--force] [--json]` | Install or update an optional local `.git/hooks/pre-push` hook that runs `preflight check` before pushing commits to a remote (refusing to overwrite an existing custom hook unless `--force` is provided). |
| `preflight bench [options]` | Run the sequential (`concurrency = 1`) curated benchmark triage suite across `bench/cases/*.json` and emit recall, false-alarm, allowlist-refusal, and latency metrics (optionally exporting `summary.md` and `results.json` via `--out`). |

**CLI Flags (`src/cli.ts`):**

| Flag | Commands | Description |
| :--- | :--- | :--- |
| `--provider <ollama\|groq\|gemini\|openrouter\|openai\|cerebras\|custom>` | `check`, `explain`, `bench` | Select the OpenAI-compatible inference provider preset (defaults to `ollama` or `PREFLIGHT_PROVIDER`). |
| `--model <name>` | `check`, `explain`, `bench` | Override the provider model identifier (or set `PREFLIGHT_MODEL`). |
| `--env-file <path>` | all commands | Load environment variables from an explicit `.env` file (Preflight auto-loads `~/.config/preflight/.env` when present and does not auto-load repo-local `.env` files). |
| `--base <ref>` | `check`, `explain` | Git base ref to diff against (default: auto-detect). |
| `--log <file>` | `check` | Attach a recent CI failure log file to `check` context. |
| `--timeout <seconds>` | `check`, `explain` | Per-command verification timeout in seconds (default: `60`). |
| `--no-verify` | `explain` | Skip local reproduction check during `explain`. |
| `--hook` | `init` | Install the git `pre-push` hook *(required for `preflight init --hook`)*. |
| `--force` | `init` | Overwrite an existing custom `pre-push` hook. |
| `--cases-dir <dir>` | `bench` | Benchmark cases directory (default: `bench/cases`). |
| `--case <id>` | `bench` | Run a single benchmark case by ID. |
| `--status <fail\|pass\|all>` | `bench` | Filter benchmark cases by status (default: `all`). |
| `--language <lang>` | `bench` | Filter benchmark cases by language (`javascript`, `typescript`, `python`). |
| `--limit <n>` | `bench` | Limit the number of benchmark cases to run. |
| `--out <dir>` | `bench` | Write benchmark `summary.md` and `results.json` to directory. |
| `--json` | all commands | Emit machine-readable, secret-redacted JSON output containing stage results, command exit codes, and Speed/Telemetry metrics. |
| `--think` | `check`, `explain`, `bench` | Opt in to enable model reasoning mode during the Think / Explain call (sends `reasoning_effort: "low"`; adds `reasoning_format: "parsed"` only on `groq` and `cerebras`). |
| `-h`, `--help` | global | Display CLI usage information. |

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

### 3.3 Optional Git `pre-push` Hook (`preflight init --hook`)

For developers and agent workflows that want automatic enforcement on every `git push` without manual agent prompting:

- `preflight init --hook` (`--hook` is required) installs an executable Preflight-managed `.git/hooks/pre-push` script (resolving standard `.git` directories as well as `gitdir:`/`commondir` pointers in linked git worktrees and submodules).
- Existing custom `pre-push` hooks are never overwritten unless `--force` is passed explicitly; re-running `preflight init --hook` on an already-managed hook is idempotent (`already_installed` / `updated`).
- On `git push`, the hook invokes `preflight check` (falling back to a local `./node_modules/.bin/preflight` install) against the local working tree.
- If all allowlisted checks exit with `0`, the push proceeds normally; if any executed check fails with a non-zero exit code, the push is aborted with a diagnostic report (and can be bypassed explicitly with `git push --no-verify` when needed).

### 3.4 Speed & Telemetry Panel

Every human-readable `preflight check` and `preflight explain` execution displays a **Speed & Telemetry Panel** (and `--json` includes the equivalent structured `telemetry` object) so users can compare local models and cloud providers. Separately, `preflight bench` aggregates per-case telemetry into its summary `metrics` object, and `preflight init --hook` emits hook installation status without invoking an LLM:

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
  "log_excerpt": "Verbatim 10–35 line excerpt from the failed GitHub Actions job log...",
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

Preflight distinguishes its **automated `preflight bench` triage metrics** from **manual/offline local checkout and `preflight explain` evaluation protocols**:

#### A. Automated `preflight bench` (`mode: "triage"`) Metrics

Evaluated sequentially across `bench/cases/*.json` using symmetric per-repo CI workflow baselines (without checking out target repositories or leaking ground-truth labels into prompts):

1. **`commandCaught`:** Count of failed-CI cases where at least one **allowlisted** predicted command matches the case's failing CI command/check.
2. **`targetCaught` (Diagnostic):** Count of failed-CI cases where `think.likely_failures[]` matches reference target paths grounded in `root_cause_label` (and `failing_command`, falling back to `changed_files` only when `root_cause_label` contains no path tokens).
3. **`caught`:** Equals **`commandCaught`** on failed-CI cases (requiring an allowlisted command match — naming a file in `likely_failures[]` without selecting an allowlisted command matching the failing CI check does not count as caught).
4. **`falseAlarms`:** Count of passing-CI cases where `think.likely_failures.length > 0`.
5. **`allowlistRefusals`:** Total number of model-proposed commands refused by the workflow-derived allowlist across evaluated cases.
6. **Latency & Throughput Percentiles (`medianWallMs`, `p95WallMs`, `medianThinkMs`, `medianTokPerSec`):** Computed strictly over **non-errored cases** (`error === null`) so fast-failing request or validation errors do not skew latency/throughput distributions.

#### B. Manual / Offline Evaluation Protocols (Outside Automated `mode: "triage"`)

1. **Local Checkout Reproduction & Exit-Code Verification:** On locally checked-out benchmark commits (`head_sha`, such as the two `<1s` anchor reproductions in [`bench/REPRO.md`](../bench/REPRO.md)), executing Verify's allowlisted commands to measure real non-zero exit-code catch rate on failed-CI cases and clean pass rate on passing-CI cases.
2. **Root-Cause Explanation Accuracy (`preflight explain`):** Offline evaluation running `preflight explain` on failed-CI logs to verify whether `root_cause` identifies the same file, symbol, and defect documented in `root_cause_label`.

### 5.4 Benchmark Honesty Rule

- Every case label in `bench/cases/` is verified against **both** the actual GitHub Actions failure log and the exact commit diff (`base_sha..head_sha` at the time CI failed, even if the PR was later amended and merged).
- Two failed-CI benchmark cases (`fail-01-express-pr-7531` and `fail-10-werkzeug-pr-3269`) have been reproduced end-to-end locally in [`bench/REPRO.md`](../bench/REPRO.md) to validate `<1s` scoped command execution.
- Never fabricate, extrapolate, or cherry-pick benchmark numbers. `preflight bench` is implemented and unit-tested (`src/bench/`), while live LLM benchmark runs (`preflight bench --out bench/results`) against local Ollama and cloud providers have not yet been executed. Live benchmark scores will be reported only from actual live runs, always stating exact denominators and distinguishing static `mode: triage` evaluation across all 35 cases from full local checkout command execution.

---

## 6. Provider Architecture & Operational Limits

Preflight talks to all inference backends through a single `OpenAICompatibleClient` targeting `POST {baseUrl}/chat/completions`.

### 6.1 Built-In Provider Presets

| Preset | Default Base URL | Default Model | Provider API Key Env Var | Default Auth Requirement |
| :--- | :--- | :--- | :--- | :--- |
| **`ollama`** *(default)* | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | `OLLAMA_API_KEY` *(optional)* | None ($0 local daemon; `Authorization` header omitted unless `PREFLIGHT_API_KEY`, `OLLAMA_API_KEY`, or `options.apiKey` is set) |
| **`groq`** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Required (`Bearer <key>`) |
| **`gemini`** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` | Required (`Bearer <key>`) |
| **`openrouter`** | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-coder-32b-instruct:free` | `OPENROUTER_API_KEY` | Required (`Bearer <key>`) |
| **`openai`** | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` | Required (`Bearer <key>`) |
| **`cerebras`** | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | Required (`Bearer <key>`) |
| **`custom`** | `PREFLIGHT_BASE_URL` | `PREFLIGHT_MODEL` | `PREFLIGHT_API_KEY` | Optional (`Bearer <key>` when set) |

### 6.2 Configuration & Operational Safeguards

| Parameter | Specification |
| :--- | :--- |
| **Config Precedence & Env Isolation** | CLI flags (`--provider`, `--model`, `--env-file`) → generic env vars (`PREFLIGHT_PROVIDER`, `PREFLIGHT_MODEL`, `PREFLIGHT_BASE_URL`, `PREFLIGHT_API_KEY`) → provider-specific env vars (`OLLAMA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, used only with the preset's default base URL; overriding `PREFLIGHT_BASE_URL` requires explicit `PREFLIGHT_API_KEY`) → preset defaults (`ollama`, `qwen2.5-coder:7b`, `http://localhost:11434/v1`). Preflight auto-loads `~/.config/preflight/.env` when present (or an explicit `--env-file <path>`) and does not auto-load repo-local `.env` files. |
| **Concurrency** | **Single-flight (`concurrency = 1`)** per process via an internal FIFO mutex queue so sequential or benchmark calls never flood local hardware or free-tier cloud rate limits. |
| **Input Context Budget** | **`<= 20,000` estimated context tokens** (`chars / 4`, `~20K` prompt tokens) per call via deterministic priority trimming in 5-tier order (+ optional `recent_ci_log` after `git diff` when `--log` is provided): (1) `git diff` (+ optional `recent_ci_log`), (2) CI commands, (3) changed files' tests, (4) changed files, (5) neighbors — trimmed in reverse priority order. |
| **Output Token Cap** | **`max_completion_tokens: ~1,500`** (`<= 2,000`), preventing runaway completions and respecting providers that pre-charge `max_completion_tokens` against per-minute token quotas. |
| **HTTP 429 Handling** | Honor `Retry-After` response header (delta-seconds or HTTP-date) when present; otherwise bounded exponential backoff with random jitter. |
| **Secret Redaction & Subprocess Isolation** | API keys are stripped from child CI subprocess environments and redacted (`[REDACTED]`) across error messages, stack traces, terminal reports, `--json`, and `--out` benchmark artifacts. |
| **Structured Outputs / Tool Calling** | Do **not** depend on provider-specific `tools` or `response_format: json_schema`. Use plain-text JSON prompts + local schema validation + at most 1 retry. |
| **Timing & Telemetry** | Always record client-side `wallTimeMs` (`performance.now()`) plus `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`), and capture optional provider `time_info` (`queue_time`, `prompt_time`, `completion_time`, `total_time`) when present in the JSON response. |

---

## 7. Project Roadmap & Phased Delivery

1. **Phase 0 — Groundwork, Open-Source Pivot & Verified Benchmark Corpus (Complete):**
   - Architecture and technical specification (`docs/SPEC.md`, `docs/DECISIONS.md`, `docs/notes/providers.md`, `docs/notes/agent-integrations.md`).
   - Provider-agnostic `OpenAICompatibleClient` (`src/clients/`) supporting `ollama` ($0 local default), `groq`, `gemini`, `openrouter`, `openai`, `cerebras`, and `custom` with single-flight queueing, HTTP 429 `Retry-After` backoff, and secret redaction.
   - CLI entry point (`src/cli.ts`), portable Agent Skill (`skills/preflight/SKILL.md`, `docs/agent-setup.md`), and curated 35-case real GitHub PR benchmark corpus (`bench/cases/*.json`, `bench/README.md`) with 2 local `<1s` reproductions (`bench/REPRO.md`).
2. **Phase 1 — Core `Gather → Think → Verify` Pipeline & Telemetry (Complete):**
   - `Gather` (`src/gather/`): git diff parser, JS/TS & Python static import graph, `.github/workflows/*.yml` command extractor, and 5-tier `<= 20,000` estimated context token (`chars / 4`) budgeter.
   - `Think` (`src/think/`): prompt builder, plain-text JSON extractor, schema validator, and 1-retry self-correction loop.
   - `Verify` (`src/verify/`): workflow-derived command allowlist validator (`shell: false`), subprocess runner with timeouts and bounded output capture, exit-code-only verdict reporter, and Speed & Telemetry panel (`src/telemetry/`).
3. **Phase 2 — `Explain`, Git `pre-push` Hook, Agent Skill & `preflight bench` Runner (Complete):**
   - `Explain` (`src/explain/`): `preflight explain <CI log URL or file>` with local file and GitHub Actions log loading (`gh api`), structured root-cause/patch diagnosis, and optional local reproduction (`--no-verify` opt-out).
   - Git `pre-push` hook installer (`src/hooks/`): `preflight init --hook` (worktree/submodule-aware, custom hook protection with `--force`).
   - Benchmark evaluation runner (`src/bench/`): sequential `preflight bench` triage evaluation with `summary.md` and `results.json` export (`--out`), plus updated `skills/preflight/SKILL.md` and `docs/agent-setup.md`.
4. **Phase 3 — Adversarial Hardening & Security Audit (Complete):**
   - Hardened workflow allowlist against shell injection, path traversal (including URI/colon/drive/comma/multi-equals payloads), flag/target swaps, and `--exit-zero`, plus fail-closed `no_checks_run` handling and secret redaction (299 Vitest tests across 12 test files at Phase 3 completion, expanded further in Phase 5).
5. **Phase 4 — Story, README & Docs Polish (Complete):**
   - Authoritative v0.1.0 `README.md`, synced `docs/SPEC.md`, `docs/DECISIONS.md`, `docs/notes/agent-integrations.md`, `docs/agent-setup.md`, and `skills/preflight/SKILL.md` with zero stale scaffold text and exact code-verified flags/contracts.
6. **Phase 5 — Final 3-Reviewer Audit Panel & Remediation (Complete on Phase 5 PR):**
   - Independent 3-reviewer code, security, and documentation panel review completed and remediated: env isolation (`~/.config/preflight/.env` + `--env-file`), custom `PREFLIGHT_BASE_URL` key guard, child CI subprocess key stripping, exact-match-only unmodeled tools, verbatim baseline flag retention, Python binary & `@args.txt` blocking, Gather symlink/merge-base hardening, provider-safe `--think` payload gating, honest `bench` command-catch scoring & non-errored percentiles, and full doc/skill alignment.
7. **Live Benchmark Run (Upcoming):**
   - Execute live `preflight bench --out bench/results` runs against local Ollama and cloud providers and publish verified recall, false-alarm, and throughput tables.
