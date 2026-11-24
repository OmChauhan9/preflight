# OpenAI-Compatible Provider Reference (`docs/notes/providers.md`)

This document provides source-verified endpoint URLs, authentication requirements, default models, rate-limit behavior, and request/response semantics for every built-in provider preset supported by Preflight's `OpenAICompatibleClient`.

---

## 1. Unified Client Architecture & Configuration Precedence

Preflight uses a single `OpenAICompatibleClient` that sends standard `POST {baseUrl}/chat/completions` requests over Node 22 native `fetch`.

### Configuration Precedence

1. **CLI Flags:** `--provider <preset>` and `--model <model-id>`
2. **Generic Environment Variables:**
   - `PREFLIGHT_PROVIDER` (`ollama` | `groq` | `gemini` | `openrouter` | `openai` | `cerebras` | `custom`)
   - `PREFLIGHT_MODEL` (overrides the preset's default model ID)
   - `PREFLIGHT_BASE_URL` (overrides the preset's default base URL; required when `PREFLIGHT_PROVIDER=custom`)
   - `PREFLIGHT_API_KEY` (overrides the provider-specific API key variable)
3. **Provider-Specific Environment Variable Fallbacks:**
   - `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`
4. **Built-In Default:** `PREFLIGHT_PROVIDER=ollama`, `PREFLIGHT_BASE_URL=http://localhost:11434/v1`, `PREFLIGHT_MODEL=qwen2.5-coder:7b` (no API key required — **$0 local-first**).

### Summary of Built-In Presets

| Preset | Base URL (`POST .../chat/completions`) | Default Model | Auth Env Var | Requires API Key? |
| :--- | :--- | :--- | :--- | :---: |
| **`ollama`** *(default)* | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | *(none)* | No ($0 local) |
| **`groq`** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Yes |
| **`gemini`** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | `GEMINI_API_KEY` | Yes |
| **`openrouter`** | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-coder-32b-instruct:free` | `OPENROUTER_API_KEY` | Yes |
| **`openai`** | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` | Yes |
| **`cerebras`** | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | Yes |
| **`custom`** | `PREFLIGHT_BASE_URL` *(required)* | `PREFLIGHT_MODEL` *(required)* | `PREFLIGHT_API_KEY` | Optional |

---

## 2. Source-Verified Provider Details

### 2.1 `ollama` (Default — $0 Local-First)

- **Base URL:** `http://localhost:11434/v1` (Chat Completions endpoint: `POST http://localhost:11434/v1/chat/completions`)
  - *Source:* [Ollama OpenAI Compatibility Documentation](https://docs.ollama.com/api/openai-compatibility) / [Ollama GitHub `docs/openai.md`](https://github.com/ollama/ollama/blob/main/docs/openai.md)
- **Default Model:** `qwen2.5-coder:7b`
  - *Source:* [Ollama `qwen2.5-coder` Library Page](https://ollama.com/library/qwen2.5-coder)
- **Authentication:** Local Ollama does not require an API key (`requiresApiKey: false`). If `PREFLIGHT_API_KEY` is unset, `OpenAICompatibleClient` omits the `Authorization` header (and Ollama ignores placeholder bearer tokens if present).
  - *Source:* [Ollama OpenAI Compatibility Documentation](https://docs.ollama.com/api/openai-compatibility)
- **Supported OpenAI Routes on Ollama:** `POST /v1/chat/completions`, `POST /v1/completions`, `GET /v1/models`, `POST /v1/embeddings`.
  - *Source:* [Ollama GitHub `docs/openai.md`](https://github.com/ollama/ollama/blob/main/docs/openai.md)
- **Local Quickstart:**
  ```bash
  ollama serve
  ollama pull qwen2.5-coder:7b
  npx preflight check
  ```

### 2.2 `groq` (Groq Cloud LPU — Free Developer Tier Available)

- **Base URL:** `https://api.groq.com/openai/v1` (Chat Completions endpoint: `POST https://api.groq.com/openai/v1/chat/completions`)
  - *Source:* [Groq OpenAI Compatibility Documentation](https://console.groq.com/docs/openai)
- **Default Model:** `llama-3.3-70b-versatile` (128K context window)
  - *Source:* [Groq Supported Models Documentation](https://console.groq.com/docs/models)
- **Authentication:** `Authorization: Bearer <GROQ_API_KEY>` (or `PREFLIGHT_API_KEY`)
  - *Source:* [Groq API Reference — Chat Completions](https://console.groq.com/docs/api-reference#chat-create)
- **Compatibility & Rate-Limit Notes:**
  - Groq returns standard `Retry-After` headers when HTTP `429 Too Many Requests` limits are hit.
  - OpenAI fields `logprobs`, `top_logprobs`, `logit_bias`, and `n > 1` are not supported on Groq and return HTTP 400 if passed; Preflight never sends those fields.
  - *Sources:* [Groq OpenAI Compatibility Documentation](https://console.groq.com/docs/openai), [Groq Rate Limits Documentation](https://console.groq.com/docs/rate-limits)

### 2.3 `gemini` (Google Gemini API — Free Tier via Google AI Studio)

- **Base URL:** `https://generativelanguage.googleapis.com/v1beta/openai` (Chat Completions endpoint: `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`)
  - *Source:* [Google Gemini API OpenAI Compatibility Guide](https://ai.google.dev/gemini-api/docs/openai)
- **Default Model:** `gemini-2.5-flash`
  - *Source:* [Google Gemini Models Documentation](https://ai.google.dev/gemini-api/docs/models)
- **Authentication:** `Authorization: Bearer <GEMINI_API_KEY>` (API key created in [Google AI Studio](https://aistudio.google.com/apikey))
  - *Source:* [Google Gemini API OpenAI Compatibility Guide](https://ai.google.dev/gemini-api/docs/openai)
- **Compatibility & Reasoning Notes:**
  - Google's OpenAI-compatible endpoint supports `POST /v1beta/openai/chat/completions` and maps OpenAI's `reasoning_effort` (`"none"`, `"low"`, `"medium"`, `"high"`) to Gemini 2.5 thinking budgets.
  - *Source:* [Google Gemini API OpenAI Compatibility Guide](https://ai.google.dev/gemini-api/docs/openai)

### 2.4 `openrouter` (OpenRouter Unified API — Free `:free` Models Available)

- **Base URL:** `https://openrouter.ai/api/v1` (Chat Completions endpoint: `POST https://openrouter.ai/api/v1/chat/completions`)
  - *Source:* [OpenRouter Quickstart Documentation](https://openrouter.ai/docs/quickstart)
- **Default Model:** `qwen/qwen-2.5-coder-32b-instruct:free` (or any free/paid model slug in the OpenRouter catalog)
  - *Source:* [OpenRouter Models Catalog](https://openrouter.ai/models)
- **Authentication:** `Authorization: Bearer <OPENROUTER_API_KEY>`
  - *Source:* [OpenRouter API Reference Overview](https://openrouter.ai/docs/api-reference/overview)
- **Compatibility Notes:**
  - Follows the standard OpenAI Chat Completions schema (`https://openrouter.ai/openapi.yaml`) and returns `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`).
  - *Source:* [OpenRouter API Reference — Chat Completions](https://openrouter.ai/docs/api-reference/chat-completion)

### 2.5 `openai` (Official OpenAI API)

- **Base URL:** `https://api.openai.com/v1` (Chat Completions endpoint: `POST https://api.openai.com/v1/chat/completions`)
  - *Source:* [OpenAI Chat Completions API Reference](https://platform.openai.com/docs/api-reference/chat/create)
- **Default Model:** `gpt-4o-mini`
  - *Source:* [OpenAI Models Overview](https://platform.openai.com/docs/models)
- **Authentication:** `Authorization: Bearer <OPENAI_API_KEY>`
  - *Source:* [OpenAI API Authentication Documentation](https://platform.openai.com/docs/api-reference/authentication)
- **Compatibility Notes:**
  - Canonical implementation of `POST /v1/chat/completions` supporting `messages`, `max_completion_tokens`, `temperature`, and `usage`.
  - *Source:* [OpenAI Chat Completions API Reference](https://platform.openai.com/docs/api-reference/chat/create)

### 2.6 `cerebras` (Cerebras Wafer-Scale Inference API)

- **Base URL:** `https://api.cerebras.ai/v1` (Chat Completions endpoint: `POST https://api.cerebras.ai/v1/chat/completions`)
  - *Source:* [Cerebras OpenAI Compatibility Documentation](https://inference-docs.cerebras.ai/openai)
- **Default Model:** `llama-3.3-70b`
  - *Source:* [Cerebras Supported Models Documentation](https://inference-docs.cerebras.ai/models/overview)
- **Authentication:** `Authorization: Bearer <CEREBRAS_API_KEY>`
  - *Source:* [Cerebras Chat Completions API Reference](https://inference-docs.cerebras.ai/api-reference/chat-completions)
- **Telemetry & Rate-Limit Notes:**
  - In addition to standard `usage` fields, Cerebras responses include a `time_info` object (`queue_time`, `prompt_time`, `completion_time`, `total_time` in seconds), which Preflight's Speed Panel captures automatically when present.
  - Cerebras pre-charges `max_completion_tokens` against per-minute token quotas at request start, which is why Preflight caps `max_completion_tokens` at `~1,500`.
  - *Sources:* [Cerebras Chat Completions API Reference](https://inference-docs.cerebras.ai/api-reference/chat-completions), [Cerebras Rate Limits Documentation](https://inference-docs.cerebras.ai/support/rate-limits)

### 2.7 `custom` (Self-Hosted & Third-Party OpenAI-Compatible Servers)

Setting `PREFLIGHT_PROVIDER=custom` (or `--provider custom`) lets Preflight connect to any local or remote server exposing `POST {PREFLIGHT_BASE_URL}/chat/completions`:

- **vLLM OpenAI-Compatible Server** (`http://localhost:8000/v1`)
  - *Source:* [vLLM OpenAI-Compatible Server Documentation](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html)
- **LM Studio Local Server** (`http://localhost:1234/v1`)
  - *Source:* [LM Studio OpenAI Compatibility Endpoints](https://lmstudio.ai/docs/app/api/endpoints/openai)
- **llama.cpp HTTP Server (`llama-server`)** (`http://localhost:8080/v1`)
  - *Source:* [llama.cpp HTTP Server Documentation](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- **LiteLLM Proxy Server** (`http://localhost:4000/v1`)
  - *Source:* [LiteLLM Proxy Quick Start](https://docs.litellm.ai/docs/proxy/quick_start)

---

## 3. Request Contract, Rate-Limit Resilience & Telemetry

### 3.1 Portable Plain-Text JSON Prompting (Why No `tools` or `response_format`)

While OpenAI supports `response_format: { type: "json_schema" }` and function calling (`tools`), open-weight models running locally under Ollama, llama.cpp, or vLLM and certain third-party routers vary in how they enforce grammar constraints or tool schemas. Per [ADR-001](../DECISIONS.md#adr-001-plain-text-json-think-output-contract--schema-validationretry), Preflight sends a standard `messages` array requesting a plain-text JSON object, strips optional markdown code fences, validates the parsed object against Preflight's schema locally, and performs at most 1 retry with the validation error message if needed.

### 3.2 Single-Flight Queue & HTTP 429 `Retry-After` Backoff

Per [ADR-007](../DECISIONS.md#adr-007-rate-limit-protection-secret-redaction--single-flight-execution):

1. **Single-Flight Queue (`concurrency = 1`):** `OpenAICompatibleClient` serializes requests through a process-wide FIFO queue so local Ollama instances and cloud free tiers are never overwhelmed by parallel requests.
2. **HTTP 429 `Retry-After` Parsing:** When an endpoint returns HTTP `429 Too Many Requests`, the client checks the standard `Retry-After` response header (supporting both integer/float seconds and HTTP-date timestamps per [MDN `Retry-After` Specification](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After)) and falls back to bounded exponential backoff with random jitter.
3. **Secret Redaction:** Any error message or debug string passes through a redaction filter that replaces the configured API key and `Bearer <token>` values with `[REDACTED]`.

### 3.3 Throughput (`tok/s`) & Wall-Clock Telemetry

On every completion call, `OpenAICompatibleClient` measures client-side `wallTimeMs` via Node's `performance.now()` ([Node.js Performance Hooks Documentation](https://nodejs.org/api/perf_hooks.html)) and extracts:

- `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`
- Optional `time_info` (`queue_time`, `prompt_time`, `completion_time`, `total_time`) when provided by the server (e.g., Cerebras)
- Effective generation throughput (`tok/s`), computed from `usage.completion_tokens / time_info.completion_time` when `time_info.completion_time > 0`, or `usage.completion_tokens / (wallTimeMs / 1000)` otherwise.
