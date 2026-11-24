# Local Benchmark Reproductions (`bench/REPRO.md`)

This document records the two end-to-end local failing-command reproductions performed on **November 20, 2026** during Phase 0 groundwork (per [ADR-006](../docs/DECISIONS.md#adr-006-benchmark-dataset-design-reproduction--honesty-rules)). Both anchor cases check out the exact failing `head_sha` of a real public GitHub pull request, install dependencies locally, execute a scoped check derived from the repository's CI workflow, and reproduce the exact CI failure and exit code in under one second of test execution.

---

## Summary

| Case ID | Repo & PR | Language / Runner | `head_sha` | Scoped Failing Command | Exit Code | Command Wall Time | Total Wall Time (incl. Clone + Install) |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: |
| [`fail-01-express-pr-7531`](./cases/fail-01-express-pr-7531.json) | `expressjs/express#7531` | JavaScript / Mocha | `5ebf19adabb6e0741eda1fecadecee9f6543ba49` | `npx mocha test/app.listRoutes.js` | `9` | `0.84s` | `8.45s` |
| [`fail-10-werkzeug-pr-3269`](./cases/fail-10-werkzeug-pr-3269.json) | `pallets/werkzeug#3269` | Python / pytest | `bb9c27fb2d425c70977b304b18b448d6525c800f` | `pytest tests/sansio/test_accept_mimetype_cases.py` | `1` | `0.80s` | `3.10s` |

---

## 1. `fail-01-express-pr-7531` (`expressjs/express#7531`)

- **Benchmark Case:** [`bench/cases/fail-01-express-pr-7531.json`](./cases/fail-01-express-pr-7531.json)
- **Pull Request:** <https://github.com/expressjs/express/pull/7531>
- **Failing CI Run:** <https://github.com/expressjs/express/actions/runs/44581270820> (`.github/workflows/ci.yml`, job `Node.js 18 - ubuntu-latest`)
- **Commits:** `base_sha = 0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8`, `head_sha = 5ebf19adabb6e0741eda1fecadecee9f6543ba49`
- **CI Full Command:** `npm test` (`.github/workflows/ci.yml` executes `npm run test-ci`, which runs the same Mocha suite under coverage)
- **Scoped Failing Command:** `npx mocha test/app.listRoutes.js`
- **Observed Result:** Exit code **`9`** — command wall time **`0.84s`** (`20ms` Mocha test duration), total wall time **`8.45s`** (including clone and `npm install`)

### Reproduction Steps

```bash
git clone --no-checkout --filter=blob:none https://github.com/expressjs/express.git express-7531
cd express-7531
git fetch origin pull/7531/head
git checkout 5ebf19adabb6e0741eda1fecadecee9f6543ba49

npm install --min-release-age=0 --no-audit --no-fund
npx mocha test/app.listRoutes.js
```

### Verbatim Local Output Excerpt

```text
  app.listRoutes()
    ✔ should return an empty array for a new application
    ✔ should capture routing settings when first inspecting an empty application
    ✔ should list routes registered through the application APIs
    ✔ should list the individual HTTP methods registered by app.all()
    ✔ should expose mounted routers for separate inspection
    ✔ should omit plain middleware
    1) should expose the router of a mounted sub-application
    2) should preserve registration order and the paths of sub-application mounts
    3) should allow inspection of nested sub-applications through their routers
    4) should expose sub-applications mounted directly on an express.Router()
    5) should reflect routes added after inspecting an empty mounted sub-application
    6) should capture routing settings when first inspecting an empty mounted sub-application
    7) should defer router creation until after mounting and configuration
    8) should preserve sub-application dispatch and restore the parent application
    9) should restore the parent application when a sub-application rejects a promise


  6 passing (20ms)
  9 failing
```

Failures 4–7 (matching the exact section captured in `fail-01-express-pr-7531.json`'s `log_excerpt`):

```text
      at Context.<anonymous> (test/app.listRoutes.js:154:12)
      at process.processImmediate (node:internal/timers:574:21)

  5) app.listRoutes()
       should reflect routes added after inspecting an empty mounted sub-application:
     TypeError: Cannot read properties of undefined (reading 'router')
      at Context.<anonymous> (test/app.listRoutes.js:165:44)
      at process.processImmediate (node:internal/timers:574:21)

  6) app.listRoutes()
       should capture routing settings when first inspecting an empty mounted sub-application:

      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

0 !== 1

      + expected - actual

      -0
      +1
      
      at Context.<anonymous> (test/app.listRoutes.js:182:12)
      at process.processImmediate (node:internal/timers:574:21)

  7) app.listRoutes()
       should defer router creation until after mounting and configuration:
     TypeError: Cannot read properties of undefined (reading 'router')
      at Context.<anonymous> (test/app.listRoutes.js:208:44)
      at process.processImmediate (node:internal/timers:574:21)
```

*(Failures 8 and 9 also reproduced identically with `TypeError: Cannot read properties of undefined (reading 'router')` at `test/app.listRoutes.js:244:43` and `test/app.listRoutes.js:271:43`.)*

### Match Against CI Log Excerpt (`fail-01-express-pr-7531.json`)

| Verification Point | GitHub Actions CI (`run_id: 44581270820`) | Local Reproduction (Nov 20, 2026) | Match |
| :--- | :--- | :--- | :---: |
| Exit code | `9` | `9` | Exact |
| Failure #4 location | `test/app.listRoutes.js:154:12` | `test/app.listRoutes.js:154:12` | Exact |
| Failure #5 error & location | `TypeError: Cannot read properties of undefined (reading 'router')` at `test/app.listRoutes.js:165:44` | `TypeError: Cannot read properties of undefined (reading 'router')` at `test/app.listRoutes.js:165:44` | Exact |
| Failure #6 error & location | `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 0 !== 1` at `test/app.listRoutes.js:182:12` | `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 0 !== 1` at `test/app.listRoutes.js:182:12` | Exact |
| Failure #7 error & location | `TypeError: Cannot read properties of undefined (reading 'router')` at `test/app.listRoutes.js:208:44` | `TypeError: Cannot read properties of undefined (reading 'router')` at `test/app.listRoutes.js:208:44` | Exact |

*(The only stack-frame difference is the Node.js internal timer line number: `node:internal/timers:476:21` on CI Node 18 vs `node:internal/timers:574:21` on the local Node runtime.)*

---

## 2. `fail-10-werkzeug-pr-3269` (`pallets/werkzeug#3269`)

- **Benchmark Case:** [`bench/cases/fail-10-werkzeug-pr-3269.json`](./cases/fail-10-werkzeug-pr-3269.json)
- **Pull Request:** <https://github.com/pallets/werkzeug/pull/3269>
- **Failing CI Run:** <https://github.com/pallets/werkzeug/actions/runs/34727229122> (`.github/workflows/tests.yaml`, job `3.10`)
- **Commits:** `base_sha = f27af2652a798931aa00c2476a4de130f597c1d3`, `head_sha = bb9c27fb2d425c70977b304b18b448d6525c800f`
- **CI Full Command:** `uv run --locked --no-default-groups --group dev tox run`
- **Scoped Failing Command:** `pytest tests/sansio/test_accept_mimetype_cases.py`
- **Observed Result:** Exit code **`1`** — command wall time **`0.80s`** (`0.23s` pytest duration), total wall time **`3.10s`** (including clone and `uv` environment install)

### Reproduction Steps

```bash
git clone --no-checkout --filter=blob:none https://github.com/pallets/werkzeug.git werkzeug-3269
cd werkzeug-3269
git fetch origin pull/3269/head
git checkout bb9c27fb2d425c70977b304b18b448d6525c800f

uv venv .venv && uv pip install --python .venv/bin/python -e . --group tests
.venv/bin/pytest tests/sansio/test_accept_mimetype_cases.py
```

### Verbatim Local Output

```text
============================= test session starts ==============================
platform darwin -- Python 3.14.7, pytest-9.2.0, pluggy-1.7.0
rootdir: /private/tmp/preflight-repro2/werkzeug-3269
configfile: pyproject.toml
plugins: timeout-2.4.0
collected 2 items

tests/sansio/test_accept_mimetype_cases.py .F                            [100%]

=================================== FAILURES ===================================
____________________ test_mime_accept_empty_header_fallback ____________________

    def test_mime_accept_empty_header_fallback():
        accept = MIMEAccept([])
>       assert accept.best_match(["application/json", "text/html"]) == "application/json"
E       AssertionError: assert None == 'application/json'
E        +  where None = best_match(['application/json', 'text/html'])
E        +    where best_match = MIMEAccept([]).best_match

tests/sansio/test_accept_mimetype_cases.py:17: AssertionError
=========================== short test summary info ============================
FAILED tests/sansio/test_accept_mimetype_cases.py::test_mime_accept_empty_header_fallback
========================= 1 failed, 1 passed in 0.23s ==========================
```

### Match Against CI Log Excerpt (`fail-10-werkzeug-pr-3269.json`)

| Verification Point | GitHub Actions CI (`run_id: 34727229122`) | Local Reproduction (Nov 20, 2026) | Match |
| :--- | :--- | :--- | :---: |
| Exit code | `1` | `1` | Exact |
| Failing test node | `FAILED tests/sansio/test_accept_mimetype_cases.py::test_mime_accept_empty_header_fallback` | `FAILED tests/sansio/test_accept_mimetype_cases.py::test_mime_accept_empty_header_fallback` | Exact |
| Failing file & line | `tests/sansio/test_accept_mimetype_cases.py:17` | `tests/sansio/test_accept_mimetype_cases.py:17` | Exact |
| Failing assertion & error | `AssertionError: assert None == 'application/json'` (`where None = best_match(['application/json', 'text/html'])`) | `AssertionError: assert None == 'application/json'` (`where None = best_match(['application/json', 'text/html'])`) | Exact |
| Scoped runtime vs CI | `1 failed, 1025 passed in 10.84s` (full pytest suite under tox) | `1 failed, 1 passed in 0.23s` (`0.80s` command wall time) | Scoped catch |
