# Preflight Benchmark Summary

- **Run Timestamp:** `2026-11-26T17:06:10.089Z`
- **Evaluation Mode:** `triage`
- **Provider / Model:** `gemini` / `gemini-3.5-flash-lite`
- **Base URL:** `https://generativelanguage.googleapis.com/v1beta/openai`
- **Cases Directory:** `bench/cases`

> **Honesty Note (`mode: triage`):** These metrics measure static Stage 2 (`Think`) triage predictions and Stage 3 (`Verify`) workflow-derived command allowlist validation against benchmark case metadata (`changed_files`, `workflow_file`, baseline CI commands) without leaking ground-truth status, logs, or root-cause labels. `Caught (allowlisted command)` requires proposing an allowlisted command matching the failing CI check; `Target Hit` is reported separately as a diagnostic metric. This is distinct from full local repository checkout and subprocess execution (see `bench/REPRO.md` for locally reproduced `<1s` anchor cases).

## Summary Metrics

| Metric | Value |
| :--- | :--- |
| total_cases | 35 (25 failed, 10 passing) |
| Caught (allowlisted command) / failedCases | 15 / 25 (60.0%) |
| Target Hit (diagnostic) / failedCases | 22 / 25 (88.0%) |
| missed / failedCases | 10 / 25 (40.0%) |
| false_alarms / passingCases | 10 / 10 (100.0%) |
| allowlist_refusals | 3 |
| errors | 0 |
| median_wall_ms | 2218.9ms |
| p95_wall_ms | 4344.1ms |
| median_think_ms | 2218.4ms |
| median_tok_per_s | 93.7 tok/s |

## Per-Case Results

| Case ID | Repo | PR | Lang | Status | Outcome | Command | Target Hit | Refused | Wall (ms) | Think (ms) | tok/s | Error |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `fail-01-express-pr-7531` | expressjs/express | #7531 | javascript | fail | missed | no | yes | 0 | 2322.6 | 2318.6 | 65.1 | - |
| `fail-02-express-pr-7112` | expressjs/express | #7112 | javascript | fail | caught | yes | yes | 0 | 1554.8 | 1554.1 | 98.4 | - |
| `fail-03-express-pr-7561` | expressjs/express | #7561 | javascript | fail | missed | no | yes | 0 | 3497.9 | 3496.5 | 45.2 | - |
| `fail-04-zod-pr-6546` | colinhacks/zod | #6546 | typescript | fail | caught | yes | yes | 0 | 4007.3 | 4006.4 | 41.9 | - |
| `fail-05-zod-pr-6559` | colinhacks/zod | #6559 | typescript | fail | caught | yes | no | 0 | 2352.5 | 2350.5 | 128.9 | - |
| `fail-06-zod-pr-6588` | colinhacks/zod | #6588 | typescript | fail | missed | no | yes | 0 | 1582.3 | 1581.5 | 131.5 | - |
| `fail-07-zod-pr-6599` | colinhacks/zod | #6599 | typescript | fail | missed | no | no | 0 | 1849.3 | 1847.8 | 102.8 | - |
| `fail-08-h3-pr-1592` | unjs/h3 | #1592 | typescript | fail | caught | yes | no | 1 | 2009.4 | 2009.0 | 83.6 | - |
| `fail-09-h3-pr-1621` | unjs/h3 | #1621 | typescript | fail | caught | yes | yes | 0 | 2218.9 | 2218.4 | 145.2 | - |
| `fail-10-werkzeug-pr-3269` | pallets/werkzeug | #3269 | python | fail | missed | no | yes | 0 | 2092.6 | 2091.6 | 79.4 | - |
| `fail-11-werkzeug-pr-3300` | pallets/werkzeug | #3300 | python | fail | caught | yes | yes | 0 | 1935.2 | 1934.5 | 137.0 | - |
| `fail-12-werkzeug-pr-3325` | pallets/werkzeug | #3325 | python | fail | caught | yes | yes | 0 | 2737.5 | 2736.6 | 74.2 | - |
| `fail-13-werkzeug-pr-3329` | pallets/werkzeug | #3329 | python | fail | caught | yes | yes | 0 | 2169.0 | 2168.4 | 113.5 | - |
| `fail-14-jinja-pr-2264` | pallets/jinja | #2264 | python | fail | caught | yes | yes | 0 | 5697.1 | 5696.4 | 48.3 | - |
| `fail-15-click-pr-3874` | pallets/click | #3874 | python | fail | missed | no | yes | 0 | 2063.2 | 2062.1 | 142.6 | - |
| `fail-16-httpx-pr-3835` | encode/httpx | #3835 | python | fail | caught | yes | yes | 0 | 3264.1 | 3263.6 | 78.4 | - |
| `fail-17-httpx-pr-3845` | encode/httpx | #3845 | python | fail | caught | yes | yes | 0 | 2213.6 | 2213.0 | 79.5 | - |
| `fail-18-pydantic-settings-pr-1051` | pydantic/pydantic-settings | #1051 | python | fail | caught | yes | yes | 0 | 2946.1 | 2945.3 | 93.7 | - |
| `fail-19-pydantic-settings-pr-1070` | pydantic/pydantic-settings | #1070 | python | fail | missed | no | yes | 0 | 4258.8 | 4258.1 | 71.6 | - |
| `fail-20-pydantic-settings-pr-1080` | pydantic/pydantic-settings | #1080 | python | fail | caught | yes | yes | 0 | 3041.2 | 3039.9 | 100.7 | - |
| `fail-21-pydantic-settings-pr-1092` | pydantic/pydantic-settings | #1092 | python | fail | missed | no | yes | 1 | 1199.7 | 1198.8 | 173.5 | - |
| `fail-22-pydantic-settings-pr-1110` | pydantic/pydantic-settings | #1110 | python | fail | caught | yes | yes | 0 | 3983.4 | 3983.0 | 68.3 | - |
| `fail-23-pydantic-settings-pr-1138` | pydantic/pydantic-settings | #1138 | python | fail | missed | no | yes | 0 | 988.1 | 987.7 | 185.3 | - |
| `fail-24-pydantic-settings-pr-1140` | pydantic/pydantic-settings | #1140 | python | fail | missed | no | yes | 0 | 1208.8 | 1208.5 | 241.6 | - |
| `fail-25-pydantic-settings-pr-1147` | pydantic/pydantic-settings | #1147 | python | fail | caught | yes | yes | 0 | 2731.1 | 2729.7 | 108.8 | - |
| `pass-01-express-pr-7578` | expressjs/express | #7578 | javascript | pass | false_alarm | - | - | 0 | 1405.7 | 1405.2 | 174.4 | - |
| `pass-02-zod-pr-6768` | colinhacks/zod | #6768 | typescript | pass | false_alarm | - | - | 0 | 1169.9 | 1169.5 | 172.7 | - |
| `pass-03-h3-pr-1636` | unjs/h3 | #1636 | typescript | pass | false_alarm | - | - | 1 | 1727.0 | 1726.7 | 135.5 | - |
| `pass-04-fastify-pr-7239` | fastify/fastify | #7239 | javascript | pass | false_alarm | - | - | 0 | 3452.2 | 3452.0 | 72.1 | - |
| `pass-05-axios-pr-11371` | axios/axios | #11371 | javascript | pass | false_alarm | - | - | 0 | 4344.1 | 4343.7 | 52.7 | - |
| `pass-06-werkzeug-pr-3345` | pallets/werkzeug | #3345 | python | pass | false_alarm | - | - | 0 | 2410.7 | 2410.4 | 73.4 | - |
| `pass-07-jinja-pr-2277` | pallets/jinja | #2277 | python | pass | false_alarm | - | - | 0 | 3280.9 | 3280.5 | 83.8 | - |
| `pass-08-click-pr-3924` | pallets/click | #3924 | python | pass | false_alarm | - | - | 0 | 3121.2 | 3120.9 | 87.2 | - |
| `pass-09-httpx-pr-3847` | encode/httpx | #3847 | python | pass | false_alarm | - | - | 0 | 2187.7 | 2187.4 | 80.0 | - |
| `pass-10-pydantic-settings-pr-1163` | pydantic/pydantic-settings | #1163 | python | pass | false_alarm | - | - | 0 | 1428.2 | 1427.9 | 145.7 | - |
