# OpenClaw Integration Guide (Phase 0 Stub)

This guide covers wiring **OpenClaw `2026.11.5`** to the Phase 0 `preflight check` CLI stub (`not implemented`, exit code `0`).

> **Environment baseline:** OpenClaw `2026.11.5` is already installed at `~/.openclaw/bin/openclaw` with `@openclaw/cerebras-provider` enabled. If `~/.openclaw/bin` is not on your `PATH`, either run `~/.openclaw/bin/openclaw` directly or add `export PATH="$HOME/.openclaw/bin:$PATH"` to your shell session.

---

## 1. Build & Expose the `preflight` Binary

From the repository root:

```bash
npm install
npm run build
```

Make `preflight` resolvable on `PATH` (required for OpenClaw's `metadata.openclaw.requires.bins: ["preflight"]` skill gate):

- **Option A — Global npm symlink (recommended):**
  ```bash
  npm link
  which preflight
  preflight check
  # Expected: not implemented (exit code 0)
  ```
- **Option B — Add a local bin directory to `PATH` without `npm link`:**
  ```bash
  mkdir -p ~/.local/bin
  chmod +x dist/cli.js
  ln -sfn "$(pwd)/dist/cli.js" ~/.local/bin/preflight
  export PATH="$HOME/.local/bin:$PATH"
  preflight check
  # Expected: not implemented (exit code 0)
  ```

If `preflight` is not linked yet, `skills/preflight/SKILL.md` also documents `node dist/cli.js check` and `npx --no-install preflight check` as execution fallbacks.

---

## 2. Expose `skills/preflight/SKILL.md` to OpenClaw

OpenClaw discovers `SKILL.md` files in this precedence order (highest to lowest):

1. `<workspace>/skills/preflight/SKILL.md` (already matches this repository when the repo root is the active OpenClaw workspace)
2. `<workspace>/.agents/skills/preflight/SKILL.md`
3. `~/.agents/skills/preflight/SKILL.md`
4. `~/.openclaw/skills/preflight/SKILL.md` (managed/global OpenClaw skills)

To make the skill available across all OpenClaw workspaces, symlink the repository's skill directory into `~/.openclaw/skills/`:

```bash
mkdir -p ~/.openclaw/skills
ln -sfn "$(pwd)/skills/preflight" ~/.openclaw/skills/preflight
```

---

## 3. Authenticate Cerebras & Register `cerebras/moonshotai-kimi-k3.1-pro-trial`

**Never put raw API keys in `~/.openclaw/openclaw.json` or commit keys to git.** Provide your Cerebras credential using either:

- OpenClaw's auth store:
  ```bash
  ~/.openclaw/bin/openclaw models auth paste-api-key --provider cerebras
  ```
- Or an environment variable in the current shell:
  ```bash
  export CEREBRAS_API_KEY="<your-cerebras-api-key>"
  ```

Register the hackathon trial model (`cerebras/moonshotai-kimi-k3.1-pro-trial`) via `openclaw config patch --stdin` (no raw API key field in config):

```bash
~/.openclaw/bin/openclaw config patch --stdin <<'EOF'
{
  "models": {
    "mode": "merge",
    "providers": {
      "cerebras": {
        "baseUrl": "https://api.cerebras.ai/v1",
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
EOF
```

> **Note (UNCONFIRMED trial parameters):** `"reasoning": false`, `"contextWindow": 131072`, and `"maxTokens": 1500` above are **UNCONFIRMED placeholders to verify at hackathon kickoff** via `openclaw models list --provider cerebras` and live API testing. Keeping `"maxTokens"` low (e.g., `1500`–`4096`) avoids unnecessary pre-charging against Cerebras's 100K TPM trial bucket.

Verify the registered model:

```bash
~/.openclaw/bin/openclaw models list --provider cerebras
~/.openclaw/bin/openclaw models status
```

---

## 4. Verify the Phase 0 Stub (One-Shot Local Run)

First confirm that `chmod +x dist/cli.js` (or `npm link`) has made `preflight` executable on `PATH` and that OpenClaw reports the skill as `✓ Ready`:

```bash
~/.openclaw/bin/openclaw skills info preflight
```

Then run a single local OpenClaw agent turn from the repository root:

```bash
~/.openclaw/bin/openclaw agent --local --agent main \
  --message "Use the preflight skill to run \`preflight check\` in the current directory and display its exact stdout/stderr output verbatim."
```

OpenClaw `2026.11.5` also supports direct one-shot execution via `openclaw agent exec` alongside `openclaw agent --local`:

```bash
~/.openclaw/bin/openclaw agent exec --cwd . \
  "Use the preflight skill to run \`preflight check\` in the current directory and display its exact stdout/stderr output verbatim."
```

**Expected result (Phase 0):** OpenClaw invokes `preflight check` via `exec` and displays `not implemented` (exit code `0`).

To validate the skill definition and CLI stub locally without calling an LLM:

```bash
npm run build && npm test
```

---

## Phase 2 Roadmap

After hackathon kickoff, `skills/preflight/SKILL.md` will be updated to run `preflight check --json` post-edit before committing so OpenClaw stays a thin trigger over Preflight's deterministic Gather -> single-flight Cerebras Kimi Think -> allowlisted Verify pipeline.
