---
name: model
description: View or set the kimi-mem memory-compression model
---

You are configuring kimi-mem's compression model. kimi-mem stores settings as flat JSON in `~/.kimi-mem/settings.json` — if the `KIMI_MEM_DATA_DIR` environment variable is set, or that file contains a `KIMI_MEM_DATA_DIR` key, the data directory (and settings.json) lives at that location instead.

The user invoked this command with arguments: `$ARGUMENTS`

First read the settings file and check `KIMI_MEM_PROVIDER`:

- If it is `kimi` (the default for Kimi Code installs — compression runs through your logged-in Kimi Code CLI):
  - If `$ARGUMENTS` is empty: report `KIMI_MEM_PROVIDER` and `KIMI_MEM_MODEL`. Explain that an empty value or any claude-style value (`haiku`/`sonnet`/`opus` or a `claude-*` id, e.g. the factory defaults) means the CLI's own `default_model` from `~/.kimi-code/config.toml` is used; any other value is passed to the CLI as `kimi -m <alias>`. Then read `~/.kimi-code/config.toml` and list the model aliases the user can pick from: the `default_model` value, the `[secondary_model]` model value, and every `[models."<alias>"]` table key (these include any third-party providers configured there, e.g. `deepseek/...`). Present them as a short numbered list with `default`/`secondary` annotations where applicable, and suggest re-running the command with one of them.
  - If `$ARGUMENTS` contains a model alias: update `KIMI_MEM_MODEL` in the settings JSON to that exact value, preserving every other key (create the file and the key if missing), then confirm the new value. If the alias does not appear in `~/.kimi-code/config.toml`'s `[models.*]` tables, still set it but warn that it is not a configured alias and compression will fail until it is.
- If it is `openrouter` (an independently-configured OpenAI-compatible API):
  - If `$ARGUMENTS` is empty: report `KIMI_MEM_PROVIDER`, `KIMI_MEM_OPENROUTER_MODEL`, `KIMI_MEM_OPENROUTER_BASE_URL`, `KIMI_MEM_TIER_SIMPLE_MODEL`, `KIMI_MEM_TIER_SUMMARY_MODEL`, and whether `KIMI_MEM_OPENROUTER_API_KEY` is set. NEVER print the API key value itself; report only "set" or "not set".
  - If `$ARGUMENTS` contains a model name (e.g. `kimi-k2.6`): update `KIMI_MEM_OPENROUTER_MODEL` in the settings JSON to that exact value, preserving every other key (create the file and the key if missing), then confirm the new value.
- Otherwise (`claude` or `gemini`): just report `KIMI_MEM_PROVIDER` and `KIMI_MEM_MODEL`, and mention that this command only edits the model for the `kimi` and `openrouter` providers.

The worker re-reads settings.json on every compression request, so the change takes effect immediately — no restart is needed.
