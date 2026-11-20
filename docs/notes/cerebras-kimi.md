# Cerebras + Kimi K3.1 Pro API Reference (`docs/notes/cerebras-kimi.md`)

> **Phase 0 Source-Verified Reference Note**
> Every factual claim below cites primary Cerebras Inference documentation (`inference-docs.cerebras.ai`). Details specific to the hackathon trial endpoint (`moonshotai-kimi-k3.1-pro-trial`) that cannot be verified prior to kickoff are explicitly marked **UNCONFIRMED / verify at kickoff**.

---

## 1. Chat Completions API Request & Response Shape

**Primary Source:** [https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)

### Endpoint & Authentication
- **Base URL:** `https://api.cerebras.ai/v1` ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions))
- **Chat Completions Route:** `POST https://api.cerebras.ai/v1/chat/completions` ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions))
- **Headers:**
  - `Authorization: Bearer $CEREBRAS_API_KEY`
  - `Content-Type: application/json`
  ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions))
- **Hackathon Trial Model ID:** `moonshotai-kimi-k3.1-pro-trial` (standard public catalog ID documented on Cerebras is `kimi-k3.1-pro`; the `-trial` suffix is hackathon-specific — **UNCONFIRMED / verify at kickoff** via `GET https://api.cerebras.ai/v1/models` — [https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions), [https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)).

### Request Parameters
| Field | Required? | Type | Description & Preflight Usage |
| :--- | :--- | :--- | :--- |
| `model` | **Required** | `string` | Model ID (`"moonshotai-kimi-k3.1-pro-trial"` for hackathon trial) ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). |
| `messages` | **Required** | `array` | Ordered array of message objects (`role`: `"system"` \| `"user"` \| `"assistant"`, `content`: `string`) ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). |
| `max_completion_tokens` | Optional (Critical) | `integer` | Maximum total tokens to generate (includes visible output tokens **plus** any reasoning tokens) ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). Set to `~1500` in Preflight's default non-reasoning mode. |
| `max_tokens` | Deprecated | `integer` | Legacy OpenAI field superseded by `max_completion_tokens` ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). Always send `max_completion_tokens`. |
| `temperature` | Optional | `number` | Sampling temperature (use `0` or `0.1` for deterministic JSON selection) ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). |
| `reasoning_effort` | Optional | `string` | Controls reasoning budget (`"none"`, `"low"`, `"medium"`, `"high"`, `"max"` depending on model) ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)). |
| `reasoning_format` | Optional | `string` | Controls how thinking tokens are returned. On `kimi-k3.1-pro`, only `"parsed"` (or omitting `reasoning_format`) is supported; `"raw"` and `"hidden"` are unsupported, and `clear_thinking` is not accepted ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)). |
| `stream` | Optional | `boolean` | Enables Server-Sent Events (SSE) streaming (`false` by default) ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). |
| `stream_options` | Optional | `object` | When `stream: true`, pass `{"include_usage": true}` to receive final `usage` and `time_info` chunk ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). |
| `response_format` / `tools` | Optional | `object` / `array` | Supported on select Cerebras models, **not used** by Preflight so we never depend on trial endpoint structured-output or tool-calling support ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). |

### `max_completion_tokens` Pre-Charge Behavior
- Before generation begins, Cerebras pre-checks organization Token-Per-Minute (TPM) quota by summing **estimated input prompt tokens + `max_completion_tokens`** (or the model's upper-bound limit if omitted) ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
- If this pre-charged sum exceeds remaining TPM quota (100K tok/min on the trial tier), the request is immediately rejected with HTTP `429 Too Many Requests` *before* inference starts; after completion, actual usage is reconciled ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
- **Implication for Preflight:** Never leave `max_completion_tokens` unset or set to `32768`. Keep it at **`1500`** in standard mode so each call pre-charges at most `prompt_tokens + 1500` against the 100K tok/min bucket ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).

### Full Non-Streaming JSON Response Shape
```json
{
  "id": "chatcmpl-b8d624a5-43d4-477a-8b94-61be750e2872",
  "object": "chat.completion",
  "created": 1775679664,
  "model": "moonshotai-kimi-k3.1-pro-trial",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{\"likely_failures\":[],\"affected_jobs\":[],\"commands\":[],\"notes\":\"\"}",
        "reasoning": "Optional thinking trace when reasoning_format='parsed'"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 3420,
    "completion_tokens": 310,
    "total_tokens": 3730,
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  },
  "time_info": {
    "queue_time": 0.000630072,
    "prompt_time": 0.04211041,
    "completion_time": 0.14090909,
    "total_time": 0.18421052,
    "created": 1775679664.285658
  }
}
```
([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions), [https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning))

---

## 2. Reasoning Capabilities (`reasoning_effort` & `reasoning_format`)

**Primary Source:** [https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)

### Documented Parameters & Model Table
Cerebras reasoning models accept two optional parameters ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)):
1. **`reasoning_effort`**: Selects the model's reasoning level. Documented values across the Cerebras catalog are `"none"`, `"low"`, `"medium"`, `"high"`, and `"max"` ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)):
   - **`kimi-k3.1-pro`** (standard Cerebras catalog entry): Documented accepted values are **`"low"`, `"medium"`, `"high"`, `"max"`**, with a documented default of **`"max"`** ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)).
   - **`kimi-k3`**: Documented accepted values are `"low"`, `"high"`, `"max"` (default `"max"`) ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)).
   - **`qwen-3.8-27b`** and **`gemma-4-31b`**: Support `"none"`, `"low"`, `"medium"`, `"high"` (where `"none"` disables reasoning; `gemma-4-31b` defaults to `"none"`) ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)).
   - **`gpt-oss-120b`**: Supports `"low"`, `"medium"`, `"high"` (default `"medium"`) ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)).
2. **`reasoning_format`**: Controls where thinking tokens appear in the response ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)):
   - **`"parsed"`**: Returns reasoning separately in `choices[0].message.reasoning` (or `delta.reasoning` when streaming), keeping `choices[0].message.content` clean for the final JSON output. **Important for Kimi K3.1 Pro:** Per Cerebras reasoning docs, `kimi-k3.1-pro` **only** supports `"parsed"` (or omitting `reasoning_format`, which defaults to `"parsed"`), does **not** support `"raw"` or `"hidden"`, and does **not** accept `clear_thinking` ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)).
   - *Other catalog models (`qwen-3.8-27b`, `gpt-oss-120b`, etc.):* Also document `"raw"` (inlines reasoning tags in `content`), `"hidden"` (omits reasoning text from payload while still billing reasoning tokens), and `"none"` (uses model default response format without disabling reasoning), but **none of `"raw"` or `"hidden"` are supported on `kimi-k3.1-pro`** ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)).

### CRITICAL KICKOFF VERIFICATION (`moonshotai-kimi-k3.1-pro-trial`)
- **UNCONFIRMED / verify at kickoff:** While the public Cerebras docs for `kimi-k3.1-pro` list `reasoning_effort` values `"low" | "medium" | "high" | "max"` with default `"max"` ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)), the hackathon trial model `moonshotai-kimi-k3.1-pro-trial` must be tested at kickoff (Sat Nov 21, 10:00 AM PT) with a 1-token smoke test to verify:
  1. Whether `reasoning_effort: "none"` is accepted on `moonshotai-kimi-k3.1-pro-trial` or if `"low"` is the minimum supported level.
  2. Whether reasoning is off by default on the `-trial` endpoint or defaults to `"max"` like standard `kimi-k3.1-pro`.
  3. **Actionable Defensive Rule for Preflight:** Always pass `reasoning_format: "parsed"` (or omit `reasoning_format`, never pass `"hidden"` or `"raw"`) so that even if the model emits thinking tokens under `"low"`, they are isolated in `message.reasoning` and never corrupt the JSON in `message.content` ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)). Also verify at kickoff whether `max_completion_tokens: 1500` is sufficient when `reasoning_effort` is `"low"` vs `"none"`.

---

## 3. `time_info`, `usage`, and Accurate Throughput (`tok/s`)

**Primary Source:** [https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)

### `time_info` Fields (All Durations in Seconds)
- `queue_time` (`float`): Seconds spent waiting in the request queue before execution ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).
- `prompt_time` (`float`): Seconds spent ingesting/prefilling the input prompt tokens ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).
- `completion_time` (`float`): Seconds spent actively generating completion tokens on the Wafer-Scale Engine ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).
- `total_time` (`float`): End-to-end server-side request latency in seconds ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).
- `created` (`float`): High-precision Unix timestamp when the metrics block was recorded ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).

### `usage` Fields
- `prompt_tokens` (`integer`): Input tokens processed ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).
- `completion_tokens` (`integer`): Total output tokens generated (including reasoning tokens if any) ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).
- `total_tokens` (`integer`): `prompt_tokens + completion_tokens` ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).

### Computing Accurate Generation Speed (`tok/s`)
- **Primary Formula (Server-Side Generation Throughput):**
  $$\text{tok/s} = \frac{\text{usage.completion\_tokens}}{\text{time\_info.completion\_time}}$$
  ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions))
- **Fallback Formula (if `completion_time` is `0` or omitted on another provider):**
  $$\text{tok/s (wall)} = \frac{\text{usage.completion\_tokens}}{\text{client\_wall\_time\_seconds}}$$

---

## 4. SSE Streaming Note (Multiple Tokens per Chunk)

**Primary Source:** [https://inference-docs.cerebras.ai/capabilities/streaming](https://inference-docs.cerebras.ai/capabilities/streaming) (and [https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions))

- Because Cerebras generates tokens at thousands of tokens per second, the API paces SSE emission at roughly **~200 evenly-spaced SSE events per second** rather than emitting one SSE frame per token ([https://inference-docs.cerebras.ai/capabilities/streaming](https://inference-docs.cerebras.ai/capabilities/streaming)).
- Consequently, **each SSE chunk (`choices[0].delta.content` or `choices[0].delta.reasoning`) typically contains multiple tokens** ([https://inference-docs.cerebras.ai/capabilities/streaming](https://inference-docs.cerebras.ai/capabilities/streaming)).
- **Rule for Preflight:** Never estimate token count or `tok/s` by counting SSE chunks. Either use non-streaming (`stream: false`) for the single-flight Think call or pass `stream_options: {"include_usage": true}` and read `usage.completion_tokens` and `time_info.completion_time` from the final summary chunk ([https://inference-docs.cerebras.ai/capabilities/streaming](https://inference-docs.cerebras.ai/capabilities/streaming)).

---

## 5. HTTP 429 Rate-Limit Handling & Backoff Strategy

**Primary Source:** [https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)

### Trial Limits
- **Requests per Minute (RPM):** `100 req/min` (specified by the **official Hackathon FAQ / `BRIEF.md`** for `moonshotai-kimi-k3.1-pro-trial`, distinct from public Cerebras developer tier rate-limit tables).
- **Tokens per Minute (TPM):** `100,000 tok/min` (specified by the **official Hackathon FAQ / `BRIEF.md`** for `moonshotai-kimi-k3.1-pro-trial`; enforced by Cerebras via dual-bucket tracking for uncached tokens and total tokens, pre-charged using `prompt_tokens + max_completion_tokens` per [https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).

### Documented Rate-Limit Response Headers
- `retry-after`: Number of seconds (or HTTP-date) to wait before retrying after an HTTP `429 Too Many Requests` response ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
- `x-ratelimit-limit-tokens-minute`: Organization TPM limit ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
- `x-ratelimit-remaining-tokens-minute`: Remaining tokens in the current minute window ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
- `x-ratelimit-reset-tokens-minute` / `x-ratelimit-reset-requests-day`: Seconds until bucket reset ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
  *(Note: Exact subset of `x-ratelimit-*` headers returned on the trial tier is **UNCONFIRMED / verify at kickoff** by inspecting raw HTTP response headers — [https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).*

### Recommended Backoff Strategy for Preflight
1. **Single-Flight Concurrency (`SingleFlightQueue` in TypeScript, concurrency = 1):** Never run concurrent Kimi requests in `preflight check` or `preflight bench`. At ~20K input tokens + 1.5K `max_completion_tokens` (~21.5K pre-charged tokens/call), at most **4 full-budget calls** fit inside a 100K TPM window per minute ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
2. **Proactive Pacing via `x-ratelimit-remaining-tokens-minute`:** In `preflight bench`, inspect `x-ratelimit-remaining-tokens-minute` on each 200 response; if remaining TPM is below `estimated_prompt_tokens + max_completion_tokens`, sleep until `x-ratelimit-reset-tokens-minute` before firing the next benchmark case ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
3. **Reactive 429 Backoff (TypeScript / Node 22):** On HTTP `429`:
   - First check the `retry-after` header (in seconds or HTTP-date); if present, sleep `Math.ceil(Number.parseFloat(retryAfter) * 1000 + (250 + Math.random() * 750))` ms ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
   - If `retry-after` is absent, use bounded exponential backoff with jitter (`baseDelayMs = 2000`, `maxDelayMs = 30000`, up to 4 retries: `2s -> 4s -> 8s -> 16s`).
