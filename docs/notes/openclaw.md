# OpenClaw Research & Integration Reference (`docs/notes/openclaw.md`)

> **Phase 0 Source-Verified Reference Note**
> Every factual claim below cites primary OpenClaw documentation. Details dependent on the hackathon trial model string (`moonshotai-kimi-k3.1-pro-trial`) are explicitly flagged as **UNCONFIRMED / verify at kickoff**.

---

## 1. Exact OpenClaw Installation Method

**Primary Source:** [https://openclaw.ai/install](https://openclaw.ai/install) and [https://docs.openclaw.ai/install](https://docs.openclaw.ai/install)

### Install Commands
- **macOS / Linux / WSL2 (official Bash installer):**
  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash
  ```
  ([https://openclaw.ai/install](https://openclaw.ai/install))
- **Alternative (ephemeral / zero-global-install via `npx`):**
  ```bash
  npx openclaw@latest
  ```
  ([https://openclaw.ai/install](https://openclaw.ai/install))
- **Windows (PowerShell):**
  ```powershell
  iwr -useb https://openclaw.ai/install.ps1 | iex
  ```
  ([https://openclaw.ai/install](https://openclaw.ai/install))

### Prerequisites
- **Node.js:** Requires **Node.js `24.16.0+`** (on the 24.x LTS line) or **Node.js `26.1.0+`** (Node 26 recommended) ([https://openclaw.ai/install](https://openclaw.ai/install)).
  - *Auto-provisioning behavior:* If Node.js is absent when `install.sh` runs, the installer attempts to provision Node 26 via Homebrew on macOS or Node 24 LTS via NodeSource on Linux ([https://openclaw.ai/install](https://openclaw.ai/install)).
- **Operating System:** macOS, Linux, or Windows (via WSL2 or native PowerShell) ([https://openclaw.ai/install](https://openclaw.ai/install)).
- **Provider Credential:** An API key (such as `CEREBRAS_API_KEY`) or existing CLI login for `openclaw onboard` ([https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md)).

### Where OpenClaw Installs Files
- **CLI Binary:** Installed into the active global npm prefix (e.g., `/opt/homebrew/bin/openclaw` or `~/.npm-global/bin/openclaw` depending on the user's Node/npm prefix) ([https://openclaw.ai/install](https://openclaw.ai/install)).
- **State, Configuration & Workspace Directory (`~/.openclaw/`):**
  - `~/.openclaw/openclaw.json` — Primary JSON/JSON5 configuration file storing model providers, agent defaults, plugin registrations, and execution policies ([https://docs.openclaw.ai/gateway/configuration](https://docs.openclaw.ai/gateway/configuration)).
  - `~/.openclaw/workspace/` — Default isolated agent workspace directory ([https://docs.openclaw.ai/gateway/configuration](https://docs.openclaw.ai/gateway/configuration)).
  - `~/.openclaw/skills/` — Managed/local skills directory ([https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)).

---

## 2. How an OpenClaw Agent Calls an External CLI (`preflight`)

**Primary Sources:**
- Skills documentation: [https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)
- Shell execution (`exec` tool): [https://docs.openclaw.ai/tools/exec](https://docs.openclaw.ai/tools/exec)
- Plugins overview: [https://docs.openclaw.ai/plugins](https://docs.openclaw.ai/plugins)

### Skills vs. Plugins vs. Tools vs. Shell Execution

| Mechanism | Role in OpenClaw | Built-in / Native? | Fit for Invoking `preflight check --json` |
| :--- | :--- | :--- | :--- |
| **Tools (`exec`, `read`, `write`, etc.)** | First-class typed actions built into the core runtime (`group:runtime` includes `exec`) ([https://docs.openclaw.ai/tools/exec](https://docs.openclaw.ai/tools/exec)). | **Yes (native)** | The `exec` tool is the underlying runtime primitive that executes shell binaries. |
| **Skills (`SKILL.md`)** | Folder-based instruction packs (`SKILL.md` with YAML frontmatter + Markdown instructions) that declare required binaries/env vars and instruct the agent *when* and *how* to call `exec` ([https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)). | **Yes (native)** | **Best fit (Preferred):** Zero custom JS bundle needed; natively gates on `bins: ["preflight"]` and `allowed-tools: [exec]`, and teaches the agent to run `preflight check --json`. |
| **Plugins (`openclaw plugins install`)** | npm/local runtime packages that register new model providers (e.g. `@openclaw/cerebras-provider`), communication channels, or custom TypeScript tools ([https://docs.openclaw.ai/plugins](https://docs.openclaw.ai/plugins)). | **Yes (extensible)** | Overkill for wrapping a single local CLI unless custom gateway hooks are required. |
| **Direct Shell Prompt (`exec`)** | Prompting `openclaw agent --message "Run preflight check --json"` without a registered skill ([https://docs.openclaw.ai/cli/agent](https://docs.openclaw.ai/cli/agent)). | **Yes (native)** | **Fallback:** Works immediately if `exec` is permitted, though less structured than a dedicated Skill. |

### Skill Directory Precedence
OpenClaw discovers `SKILL.md` files in the following precedence order (highest to lowest) ([https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)):
1. `<workspace>/skills/<skill-name>/SKILL.md` (Workspace skills, e.g., `~/.openclaw/workspace/skills/preflight/SKILL.md` or project workspace)
2. `<workspace>/.agents/skills/<skill-name>/SKILL.md` (Project agent skills)
3. `~/.agents/skills/<skill-name>/SKILL.md` (Personal agent skills)
4. `~/.openclaw/skills/<skill-name>/SKILL.md` (Managed/global OpenClaw skills)

### Exact `SKILL.md` Schema for `preflight`
To register `preflight` as an OpenClaw skill, create `~/.openclaw/skills/preflight/SKILL.md` (or `<workspace>/skills/preflight/SKILL.md`) and validate frontmatter placement (`allowed-tools`, `metadata.openclaw`) with `openclaw skills check` ([https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)):

```markdown
---
name: preflight
description: Run Preflight pre-push CI verification (preflight check --json) or CI failure explanation (preflight explain) and report the verdict and Cerebras Speed panel.
version: 0.1.0
allowed-tools:
  - exec
metadata:
  openclaw:
    requires:
      bins:
        - preflight
      env:
        - CEREBRAS_API_KEY
    primaryEnv: CEREBRAS_API_KEY
---

# Preflight Skill

When the user asks to run Preflight, check a branch before push, or verify whether local changes break CI:

1. Invoke the `exec` tool in the target git repository directory:
   ```bash
   preflight check --json
   ```
   *(Note: During Phase 0 stub verification, `preflight check` outputs `not implemented` with exit code 0.)*
2. In Phase 1/2, parse the JSON response fields (matching `docs/SPEC.md`):
   - `status` (`"passed"`, `"failed"`, `"timed_out"`, or `"refused"`)
   - `think` (`likely_failures`, `affected_jobs`, `commands`, `notes`)
   - `verify` (per-command `command`, `status` [`"passed" | "failed" | "timed_out" | "refused"`], `exit_code`, `duration_ms`, `output`)
   - `telemetry` (`provider`, `model`, `prompt_tokens`, `completion_tokens`, `tokens_per_sec`, `time_info`, `wall_time_ms` split into `gather`, `think`, `verify`)
3. Present a concise summary showing:
   - Which real commands passed, failed, timed out, or were refused (by exit code — never claim "CI will pass").
   - The Cerebras Speed panel (`prompt_tokens`, `completion_tokens`, `tok/s`, `queue_time`, `prompt_time`, `completion_time`, `total_time`, and `gather`/`think`/`verify` wall times).
```

---

## 3. Installing & Configuring `@openclaw/cerebras-provider`

**Primary Source:** [https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md) and [https://docs.openclaw.ai/gateway/configuration](https://docs.openclaw.ai/gateway/configuration)

### Step 1: Install the Provider Plugin
```bash
openclaw plugins install @openclaw/cerebras-provider
```
- **Provider ID:** `cerebras` ([https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md))
- **API Standard:** `openai-completions` against base URL `https://api.cerebras.ai/v1` ([https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md))
- **Environment Variable:** `CEREBRAS_API_KEY` ([https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md))
- **Default Catalog Model:** `@openclaw/cerebras-provider` defaults to `cerebras/gpt-oss-120b` (or catalog default) unless overridden ([https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md)).

### Step 2: Authenticate with `CEREBRAS_API_KEY`
```bash
export CEREBRAS_API_KEY="csk-..."
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice cerebras-api-key \
  --cerebras-api-key "$CEREBRAS_API_KEY"
```
([https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md))

### Step 3: Override the Default Model to `moonshotai-kimi-k3.1-pro-trial`
Because `moonshotai-kimi-k3.1-pro-trial` is a hackathon trial model ID, it may not be pre-listed in `@openclaw/cerebras-provider`'s static manifest (**UNCONFIRMED / verify at kickoff** via `openclaw models list --provider cerebras` — [https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md)).

OpenClaw supports two ways to override the active model to `cerebras/moonshotai-kimi-k3.1-pro-trial`:

1. **Declarative override in `~/.openclaw/openclaw.json` (`models.mode: "merge"`):**
   Explicitly register `moonshotai-kimi-k3.1-pro-trial` under `models.providers.cerebras.models` and set `agents.defaults.model.primary` ([https://docs.openclaw.ai/gateway/configuration](https://docs.openclaw.ai/gateway/configuration)):
   ```json
   {
     "models": {
       "mode": "merge",
       "providers": {
         "cerebras": {
           "baseUrl": "https://api.cerebras.ai/v1",
           "apiKey": "${CEREBRAS_API_KEY}",
           "api": "openai-completions",
           "models": [
             {
               "id": "moonshotai-kimi-k3.1-pro-trial",
               "name": "Kimi K3.1 Pro (Cerebras Trial)",
               "reasoning": false,
               "input": ["text"],
               "contextWindow": 131072,
               "maxTokens": 1500
             }
           ]
         }
       }
     },
     "agents": {
       "defaults": {
         "model": {
           "primary": "cerebras/moonshotai-kimi-k3.1-pro-trial"
         }
       }
     }
   }
   ```
   - **UNCONFIRMED / verify at kickoff (`reasoning`, `contextWindow`, `maxTokens` for `moonshotai-kimi-k3.1-pro-trial`):**
     - The exact `contextWindow`, `maxTokens`, and `reasoning` manifest attributes for `moonshotai-kimi-k3.1-pro-trial` are **UNCONFIRMED / verify at kickoff** via `openclaw models list --provider cerebras` and `GET https://api.cerebras.ai/v1/models` ([https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md), [https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).
     - Note that native Kimi K3.1 Pro supports up to a `1,048,576`-token context window on Moonshot ([https://platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)), while Cerebras trial context limits must be verified at kickoff.
     - **Critical TPM Pre-Charge Warning:** Keep `maxTokens` low (e.g., `1500`, matching Preflight's `~1,500` `max_completion_tokens` budget) rather than `8192+`, because Cerebras pre-charges `prompt_tokens + max_completion_tokens` against the hackathon trial's `100,000 tok/min` (100K TPM) budget (per official Hackathon FAQ / `BRIEF.md` and [https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)).
2. **CLI model switch & verification:**
   ```bash
   openclaw models set cerebras/moonshotai-kimi-k3.1-pro-trial
   openclaw models list --provider cerebras
   openclaw models status
   ```
   ([https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md))

---

## 4. Recommendation: Phase 0 Stub & Phase 2 Wiring

### Phase 0 Stub (Before Sat Nov 21, 10:00 AM PT)
1. **Install OpenClaw (after user approval)** using `curl -fsSL https://openclaw.ai/install.sh | bash` and install `@openclaw/cerebras-provider` via `openclaw plugins install @openclaw/cerebras-provider` ([https://openclaw.ai/install](https://openclaw.ai/install), [https://docs.openclaw.ai/providers/cerebras.md](https://docs.openclaw.ai/providers/cerebras.md)).
2. **Register the `preflight` Skill (`SKILL.md`)** in `~/.openclaw/skills/preflight/SKILL.md` (and commit a copy in the repo at `.agents/skills/preflight/SKILL.md` so project-level discovery also works automatically) ([https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)).
3. **Verify the Phase 0 CLI stub via OpenClaw:**
   Run a single local agent turn invoking the Phase 0 `preflight check` stub (which outputs `not implemented`):
   ```bash
   openclaw agent --local --agent main --message "Run preflight check in the current directory and display the output."
   ```
   ([https://docs.openclaw.ai/cli/agent](https://docs.openclaw.ai/cli/agent))

### Phase 2 Wiring (During Hackathon Build Window)
1. **Keep the architecture thin:** OpenClaw acts as the conversational agent trigger, while `preflight check --json` performs the deterministic Gather -> single-flight Cerebras Kimi Think -> allowlisted Verify pipeline.
2. **Why this avoids rate-limit waste:** Routing the inner Think call directly inside `preflight` (rather than having OpenClaw do multi-turn tool-calling reasoning loops) preserves the `100 req/min` and `100K tok/min` Cerebras hackathon trial budget (specified in the official Hackathon FAQ / `BRIEF.md`, with pre-charge behavior documented at [https://inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits)) and captures exact `time_info` telemetry (`queue_time`, `prompt_time`, `completion_time`, `total_time`) directly from the Cerebras HTTP response ([https://inference-docs.cerebras.ai/api-reference/chat-completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)).
3. **Fallback path:** If the OpenClaw Gateway daemon is slow or unavailable during live recording, `openclaw agent --local --agent main --message "Run preflight check"` executes directly via the embedded local runner ([https://docs.openclaw.ai/cli/agent](https://docs.openclaw.ai/cli/agent)).
