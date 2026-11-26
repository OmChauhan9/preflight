# Preflight Benchmark Corpus (`bench/`)

A curated, hand-verified benchmark corpus of **35 real GitHub Pull Request CI runs** (**25 failed PR runs** and **10 passing PR runs**) across **10 open-source JavaScript/TypeScript and Python repositories**. Every failed case was audited against **both** the actual GitHub Actions CI log window and the PR code diff to guarantee that the CI failure is directly caused by the PR's code change rather than CI infrastructure issues, runner flakiness, or upstream dependency drift.

---

## Corpus Summary

| Metric | Count | Breakdown |
| :--- | :---: | :--- |
| **Total Benchmark Cases** | **35** | 25 failed (`fail-01` .. `fail-25`), 10 passing (`pass-01` .. `pass-10`) |
| **JavaScript / TypeScript Cases** | **14** | 9 failed, 5 passing across 5 repositories |
| **Python Cases** | **21** | 16 failed, 5 passing across 5 repositories |
| **Locally Reproduced Anchor Cases** | **2** | `expressjs/express#7531` (`fail-01`), `pallets/werkzeug#3269` (`fail-10`) — see [`bench/REPRO.md`](./REPRO.md) |

### Repository & Language Coverage

| Repository | Language | Failed Cases | Passing Cases | Total |
| :--- | :--- | :---: | :---: | :---: |
| `expressjs/express` | JavaScript | 3 (`#7531`, `#7112`, `#7561`) | 1 (`#7578`) | **4** |
| `colinhacks/zod` | TypeScript | 4 (`#6546`, `#6559`, `#6588`, `#6599`) | 1 (`#6768`) | **5** |
| `unjs/h3` | TypeScript | 2 (`#1592`, `#1621`) | 1 (`#1636`) | **3** |
| `fastify/fastify` | JavaScript | 0 | 1 (`#7239`) | **1** |
| `axios/axios` | JavaScript | 0 | 1 (`#11371`) | **1** |
| `pallets/werkzeug` | Python | 4 (`#3269`, `#3300`, `#3325`, `#3329`) | 1 (`#3345`) | **5** |
| `pallets/jinja` | Python | 1 (`#2264`) | 1 (`#2277`) | **2** |
| `pallets/click` | Python | 1 (`#3874`) | 1 (`#3924`) | **2** |
| `encode/httpx` | Python | 2 (`#3835`, `#3845`) | 1 (`#3847`) | **3** |
| `pydantic/pydantic-settings` | Python | 8 (`#1051`, `#1070`, `#1080`, `#1092`, `#1110`, `#1138`, `#1140`, `#1147`) | 1 (`#1163`) | **9** |
| **Total** | **JS/TS + Python** | **25** | **10** | **35** |

> **Note:** On GitHub, `unjs/h3` redirects to `h3js/h3`; the `pr_url` and `run_url` fields in the `h3` case files reflect the canonical `h3js/h3` redirect.

### Failure Category Breakdown (25 Failed Cases)

| Failure Category | Count | Cases |
| :--- | :---: | :--- |
| **Unit Test (`unit_test`)** | **13** | `fail-01` (`express#7531`), `fail-02` (`express#7112`), `fail-03` (`express#7561`), `fail-06` (`zod#6588`), `fail-07` (`zod#6599`), `fail-09` (`h3#1621`), `fail-10` (`werkzeug#3269`), `fail-15` (`click#3874`), `fail-16` (`httpx#3835`), `fail-19` (`pydantic-settings#1070`), `fail-21` (`pydantic-settings#1092`), `fail-23` (`pydantic-settings#1138`), `fail-24` (`pydantic-settings#1140`) |
| **Typecheck (`typecheck`)** | **5** | `fail-11` (`werkzeug#3300`), `fail-12` (`werkzeug#3325`), `fail-13` (`werkzeug#3329`), `fail-14` (`jinja#2264`), `fail-20` (`pydantic-settings#1080`) |
| **Lint / Format (`lint_format`)** | **7** | `fail-04` (`zod#6546`), `fail-05` (`zod#6559`), `fail-08` (`h3#1592`), `fail-17` (`httpx#3845`), `fail-18` (`pydantic-settings#1051`), `fail-22` (`pydantic-settings#1110`), `fail-25` (`pydantic-settings#1147`) |

---

## Case JSON Schema (`bench/cases/*.json`)

Every file in `bench/cases/` conforms to the following schema:

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
  "log_excerpt": "...",
  "changed_files": ["lib/application.js", "package.json", "test/app.listRoutes.js"],
  "root_cause_label": "unit_test: ...",
  "label_verified": {
    "checked_against_log": true,
    "checked_against_diff": true,
    "notes": "..."
  }
}
```

- **`status`**: `"fail"` for failing CI runs or `"pass"` for passing CI runs.
- **`failing_job`**, **`failing_command`**, **`log_excerpt`**: Populated with exact CI job name, workflow command from `.github/workflows/*.yml`, and verbatim 10–35 line CI log excerpt for `"fail"` cases; `null` for `"pass"` cases.
- **`root_cause_label`**: For `"fail"` cases, prefixed with category (`unit_test:`, `typecheck:`, or `lint_format:`) followed by the exact file, symbol/line, and failure cause introduced by the PR diff. For `"pass"` cases, prefixed with `passing:` followed by a concise summary of the verified code change.
- **`label_verified`**: Records explicit dual verification against both the CI failure log (`checked_against_log: true`) and the PR patch (`checked_against_diff: true`), with a 1-sentence link in `notes`.

---

## Curation & Rejection Methodology

From the 37 raw failed PR candidates fetched from GitHub Actions, **12 candidates were rejected** after cross-checking their CI logs against their PR diffs:

1. **CI Infrastructure / Runner Provisioning Errors (1 rejected)**:
   - `colinhacks/zod#6710`: Failed in `ERR_NUB_NODE_PROVISION_FAILED` due to an HTTP 404 downloading Node `v27.0.0` from `nodejs.org`, unrelated to the PR diff.
2. **Upstream Packaging / Bundler Drift Unrelated to PR Diff (4 rejected)**:
   - `encode/httpx#3783`: Failed in `twine check` (`Invalid distribution metadata: '2.5'`) because an isolated build installed a newer `hatchling` emitting PEP 639 Metadata-Version 2.5 while `requirements.txt` pinned `twine==6.1.0`; the PR only touched redirect method handling in `httpx/_client.py`.
   - `unjs/h3#1585`, `unjs/h3#1629`, `unjs/h3#1655`: All three failed on the identical assertion in `test/bench/bundle.test.ts` (`bundle size (defineHandler): expected 7045 to be less than or equal to 7040`), even when `defineHandler` and its transitive imports were untouched (`src/utils/static.ts` in `#1585`, `src/rules/readings.ts` in `#1655`), indicating upstream dependency/bundler size drift on `base_sha`.
3. **Flaky / Unrelated Timing & Resource Warnings (2 rejected)**:
   - `encode/httpx#3796`: Failed due to an asynchronous generator garbage-collection race (`PytestUnraisableExceptionWarning: Exception ignored in: <async_generator object ByteStream.__aiter__>`) during `PUT /slow_response`, unrelated to the PR's version bump.
   - `pallets/werkzeug#3346`: Failed after 801 seconds on a macOS CI runner with `TimeoutError: [Errno 60] Operation timed out` in `test_host_with_ipv6_scope`.
4. **Spam / Vandalism PRs & Redundant Formatting Duplicates (5 rejected)**:
   - `pallets/click#3871`, `pallets/click#3872`, `pallets/click#3873`: Three duplicate PRs titled `"spam"` that deleted `IntParamType._number_class = int`.
   - `pydantic/pydantic-settings#1085`, `pydantic/pydantic-settings#1130`: Redundant `ruff format --check` line-wrap failures in `pydantic/pydantic-settings` (already represented by `fail-18-pydantic-settings-pr-1051`, alongside `ruff check` rules `Q000` in `fail-22` and `I001` in `fail-25`).

---

## Locally Reproduced Failing Cases

Two anchor cases in this corpus have been locally reproduced end-to-end by checking out their exact `head_sha` and executing their failing CI test commands:

- **`fail-01-express-pr-7531`** (`expressjs/express` PR `#7531`, commit `5ebf19adabb6e0741eda1fecadecee9f6543ba49`)
- **`fail-10-werkzeug-pr-3269`** (`pallets/werkzeug` PR `#3269`, commit `bb9c27fb2d425c70977b304b18b448d6525c800f`)

See [`bench/REPRO.md`](./REPRO.md) for the exact local reproduction commands and outputs.

---

## Published Live Results

The latest committed live triage benchmark run is archived in [`bench/results/summary.md`](./results/summary.md) and [`bench/results/results.json`](./results/results.json):

- **Command:** `node dist/cli.js bench --provider gemini --delay 4200 --out bench/results` (Gemini Free Tier, `$0`)
- **Timestamp:** `2026-11-26T17:06:10.089Z`
- **Provider / Model:** `gemini` / `gemini-3.5-flash-lite` (`https://generativelanguage.googleapis.com/v1beta/openai`)
- **Mode:** `triage` (static Stage 2 `Think` + Stage 3 workflow-derived allowlist validation against case metadata — distinct from full local checkout and subprocess execution)

| Metric | Value |
| :--- | :--- |
| **Total Cases** | `35` (`25` failed, `10` passing across 10 JS/TS & Python repos) |
| **Caught (exact allowlisted failing CI command)** | **`15 / 25` (`60.0%`)** (`typecheck`: `5 / 5`, `lint_format`: `7 / 7`, `unit_test`: `3 / 13`) |
| **Target Hit (diagnostic, `root_cause_label`)** | **`22 / 25` (`88.0%`)** (`typecheck`: `5 / 5`, `lint_format`: `5 / 7`, `unit_test`: `12 / 13`) |
| **Missed** | **`10 / 25` (`40.0%`)** (all 10 in `unit_test`, where the model chose an allowlisted scoped runner such as `npm test <file>`, `pnpm test`, or `pytest <file>` instead of the CI wrapper) |
| **Static-Triage False Alarms (passing PRs)** | **`10 / 10` (`100.0%`)** (`likely_failures.length > 0` without diff hunks or command execution) |
| **Allowlist Refusals** | **`3`** (`fail-08`, `fail-21`, `pass-03`) |
| **Errors** | **`0`** |
| **Latency & Throughput** | Median wall **`2,218.9 ms`** (`p95`: `4,344.1 ms`), median think `2,218.4 ms`, median **`93.7 tok/s`** |

> **Honesty Note:** Static `mode: triage` reports `10 / 10` false alarms on passing PRs because the model sees only changed file paths and baseline CI commands — never diff hunks or subprocess outputs. In real `preflight check` runs, pass/fail verdicts come 100% from executed allowlisted subprocess exit codes, never from LLM triage predictions alone.
