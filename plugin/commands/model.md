---
name: model
description: View or set the kimi-mem memory-compression model
---

You are configuring kimi-mem's compression model. kimi-mem stores settings as flat JSON in `~/.kimi-mem/settings.json` — if the `KIMI_MEM_DATA_DIR` environment variable is set, or that file contains a `KIMI_MEM_DATA_DIR` key, the data directory (and settings.json) lives at that location instead.

The user invoked this command with arguments: `$ARGUMENTS`

- If `$ARGUMENTS` is empty: read the settings file and report the current compression configuration — `KIMI_MEM_PROVIDER`, `KIMI_MEM_OPENROUTER_MODEL`, `KIMI_MEM_OPENROUTER_BASE_URL`, `KIMI_MEM_TIER_SIMPLE_MODEL`, `KIMI_MEM_TIER_SUMMARY_MODEL` — and whether `KIMI_MEM_OPENROUTER_API_KEY` is set. NEVER print the API key value itself; report only "set" or "not set".
- If `$ARGUMENTS` contains a model name (e.g. `kimi-k2.6`): update `KIMI_MEM_OPENROUTER_MODEL` in the settings JSON to that exact value, preserving every other key (create the file and the key if missing), then confirm the new value to the user.

The worker re-reads settings.json on every compression request, so the change takes effect immediately — no restart is needed.
