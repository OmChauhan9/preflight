# GPU Baseline Provider Reference: Moonshot Kimi API (`docs/notes/gpu-provider.md`)

> **Phase 0 Source-Verified Reference Note**
> This document covers Moonshot AI's native OpenAI-compatible Kimi API (`platform.moonshot.ai`) used for `--provider gpu` (`--provider moonshot`) side-by-side latency and throughput comparison against `--provider cerebras`. Every factual claim cites primary Moonshot AI documentation.

---

## 1. Moonshot Kimi OpenAI-Compatible API Overview

**Primary Source:** [https://platform.moonshot.ai/docs/intro](https://platform.moonshot.ai/docs/intro) and [https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)

### Base URLs (Global vs. China)
- **Global Endpoint (Default for Preflight `--provider gpu`):**
  ```text
  https://api.moonshot.ai/v1
  ```
  ([https://platform.moonshot.ai/docs/intro](https://platform.moonshot.ai/docs/intro))
- **China Regional Endpoint (Optional override via `MOONSHOT_BASE_URL`):**
  ```text
  https://api.moonshot.cn/v1
  ```
  ([https://platform.moonshot.ai/docs/intro](https://platform.moonshot.ai/docs/intro))
- **Chat Completions Route:**
  ```text
  POST https://api.moonshot.ai/v1/chat/completions
  ```
  ([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat))
  *(Note: API keys created on the global console `platform.moonshot.ai` must use `https://api.moonshot.ai/v1`, whereas keys from `platform.moonshot.cn` use `https://api.moonshot.cn/v1` — [https://platform.moonshot.ai/docs/intro](https://platform.moonshot.ai/docs/intro)).*

### Authentication & Environment Variable Convention
- **Environment Variable:** `MOONSHOT_API_KEY` ([https://platform.moonshot.ai/docs/intro](https://platform.moonshot.ai/docs/intro))
- **HTTP Header:**
  ```http
  Authorization: Bearer $MOONSHOT_API_KEY
  Content-Type: application/json
  ```
  ([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat))

### Documented Kimi Model IDs on Moonshot
| Model ID | Description | Context Window | Pricing (Input / Output per 1M tokens) |
| :--- | :--- | :--- | :--- |
| **`kimi-k3.1-pro`** | Flagship Kimi K3.1 Pro model (direct architectural match for Cerebras `moonshotai-kimi-k3.1-pro-trial`) ([https://platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)). | 1,048,576 tokens ([https://platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)) | $2.00 / $10.00 ($0.20 cached input) ([https://platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)) |
| **`kimi-k3.1-pro-highspeed`** | High-speed GPU deployment of Kimi K3.1 Pro ([https://platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)). | 1,048,576 tokens ([https://platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)) | $4.00 / $20.00 ($0.20 cached input) ([https://platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)) |
| **`kimi-k3`** | Standard Kimi K3 model ([https://platform.moonshot.ai/docs/intro](https://platform.moonshot.ai/docs/intro)). | 1,048,576 tokens ([https://platform.moonshot.ai/docs/intro](https://platform.moonshot.ai/docs/intro)) | Tiered per Moonshot pricing docs ([https://platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)) |

> **Kickoff Note:** Confirm at kickoff via `GET https://api.moonshot.ai/v1/models` with our `MOONSHOT_API_KEY` whether `kimi-k3.1-pro` is accessible on our account tier, and allow overriding the GPU baseline model ID via `PREFLIGHT_GPU_MODEL` (defaulting to `kimi-k3.1-pro`) ([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)).

---

## 2. Chat Completions Request & Response Shape

**Primary Source:** [https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)

### Example Request (`POST /v1/chat/completions`)
```json
{
  "model": "kimi-k3.1-pro",
  "messages": [
    {
      "role": "system",
      "content": "You are Preflight. Output only valid JSON matching the Think schema."
    },
    {
      "role": "user",
      "content": "<diff and workflow context>"
    }
  ],
  "max_completion_tokens": 1500,
  "temperature": 0.0,
  "reasoning_effort": "low"
}
```
- **Reasoning Parameter on Moonshot:** Moonshot's `kimi-k3.1-pro` supports top-level `reasoning_effort` with documented values `"low"`, `"high"`, or `"max"` (default `"max"`) ([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)).
- **Reasoning Field in Response:** Unlike Cerebras (which uses `message.reasoning` when `reasoning_format: "parsed"`), Moonshot returns thinking tokens in **`choices[0].message.reasoning_content`** (or `delta.reasoning_content` when streaming) ([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)).

### Example Response Shape
```json
{
  "id": "chatcmpl-65f1a2b3c4d5e6f7a8b9c0d1",
  "object": "chat.completion",
  "created": 1775679700,
  "model": "kimi-k3.1-pro",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{\"likely_failures\":[],\"affected_jobs\":[],\"commands\":[],\"notes\":\"\"}",
        "reasoning_content": "Optional thinking trace returned by Moonshot API..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 3420,
    "completion_tokens": 310,
    "total_tokens": 3730,
    "cached_tokens": 0
  }
}
```
([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat))

---

## 3. Key Differences: Cerebras (`--provider cerebras`) vs. Moonshot GPU (`--provider gpu`)

**Primary Sources:**
- Cerebras Chat Completions: [https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)
- Cerebras Reasoning: [https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)
- Moonshot Chat Completions: [https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)

| Dimension | Cerebras (`--provider cerebras`) | Moonshot GPU (`--provider gpu` / `moonshot`) | Preflight Implementation Handling |
| :--- | :--- | :--- | :--- |
| **Base URL** | `https://api.cerebras.ai/v1` | `https://api.moonshot.ai/v1` (or `.cn/v1`) | Configurable per provider adapter. |
| **API Key Env Var** | `CEREBRAS_API_KEY` | `MOONSHOT_API_KEY` | Check only the active provider's env var. |
| **Model ID** | `moonshotai-kimi-k3.1-pro-trial` | `kimi-k3.1-pro` | Same underlying Kimi K3.1 Pro weights for apples-to-apples speed comparison. |
| **`time_info` Object** | **Present:** Returns `queue_time`, `prompt_time`, `completion_time`, `total_time` in seconds ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)). | **Absent:** Moonshot does **not** return a `time_info` object ([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)). | On `--provider gpu`, set `time_info` fields to `null` (or `"N/A (GPU provider)"` in UI) and measure `think_wall_time_s` client-side via `time.perf_counter()`. |
| **`tok/s` Calculation** | `usage.completion_tokens / time_info.completion_time` (pure generation speed) + client wall time. | `usage.completion_tokens / client_wall_time_s` (or time from first token to last token if streaming). | Report both server `completion_time` tok/s (when available) and end-to-end `think` wall time so comparisons are transparent. |
| **Reasoning Output Field** | `choices[0].message.reasoning` (with `reasoning_format: "parsed"`) ([https://inference-docs.cerebras.ai/capabilities/reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning)). | `choices[0].message.reasoning_content` ([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)). | Normalize `message.reasoning ?? message.reasoning_content` in the provider adapter; parse `message.content` for the Think JSON contract. |
| **Token Budget if Reasoning Cannot Be Disabled** | `max_completion_tokens: 1500` when reasoning is off/minimal. | `kimi-k3.1-pro` on Moonshot defaults to `reasoning_effort: "max"` and its minimum documented setting is `"low"` ([https://platform.moonshot.ai/docs/api/chat](https://platform.moonshot.ai/docs/api/chat)). | Pass `reasoning_effort: "low"` on Moonshot GPU and allow a slightly higher `max_completion_tokens` (e.g., `2500–4096`) on `--provider gpu` if `"low"` still emits thinking tokens before the JSON answer. |
| **Rate Limits** | Fixed trial tier: `100 req/min`, `100,000 tok/min` (pre-charged `prompt_tokens + max_completion_tokens`) ([https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)). | Account-tier dependent (Tier 1–Tier 5 based on cumulative recharge balance) ([https://platform.moonshot.ai/docs/pricing/limits](https://platform.moonshot.ai/docs/pricing/limits)). | Keep single-flight execution and 429 exponential backoff enabled for both providers. |
