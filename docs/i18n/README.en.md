<h1 align="center">kimi-mem</h1>

<h4 align="center">Persistent cross-session memory built for <a href="https://github.com/MoonshotAI/kimi-code">Kimi Code</a></h4>

<p align="center">
  <a href="../../README.md">🇨🇳 中文</a> • 🇬🇧 <b>English (this page)</b>
</p>

<p align="center">
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="../../package.json"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node"></a>
</p>

> **kimi-mem** is a fork of [claude-mem](https://github.com/thedotmack/claude-mem) by [@thedotmack](https://github.com/thedotmack) (Apache-2.0), adapted for [Kimi Code](https://github.com/MoonshotAI/kimi-code): compression reuses your logged-in Kimi Code models by default, and installation registers a native Kimi Code plugin.

kimi-mem keeps your AI coding assistant's context **alive across sessions**: it automatically captures tool calls and conversations, compresses them into structured memories with an LLM, stores them in a local database, and injects relevant memories back into future sessions. Close the session, reboot, switch windows — project knowledge survives.

## Features

- 🧠 **Persistent cross-session memory** — relevant project history is injected into new sessions (once per session, on your first prompt)
- 🗜️ **LLM memory compression** — reuses your logged-in Kimi Code models by default (including third-party models configured in config.toml); no separate API key required
- 🔍 **Natural-language search** — MCP search tools + the mem-search skill, with a 3-layer progressive-disclosure workflow that saves tokens
- 🔌 **Native plugin form** — installs as a Kimi Code plugin (hooks / MCP / skills / slash commands in one), manageable from the plugin manager
- 🖥️ **Live web viewer** — watch the memory stream in your browser (default port near 37777)
- 🔒 **Privacy controls** — `<private>` tags exclude sensitive content; all data stays local in `~/.kimi-mem/`
- 🤖 **Fully automatic** — zero intervention after install

## Quick Start

### One-click install

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/YD-233/kimi-mem/main/install.ps1 | iex
```

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/YD-233/kimi-mem/main/install.sh | bash
```

The script: checks node (≥20) → auto-installs bun if missing → clones the repo to `~/.kimi-mem/repo` → installs the plugin into Kimi Code (`plugins/managed/kimi-mem/` + an `installed.json` record).

**Restart Kimi Code (or `/reload`)** after installing, then just use Kimi Code normally — memory accumulates automatically. From your second session onward you'll see injected history.

### Updating

Re-run the one-click install command: the script pulls the latest code, refreshes the plugin files, and restarts the worker so updates take effect.

### Uninstall

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/YD-233/kimi-mem/main/uninstall.ps1 | iex
```

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/YD-233/kimi-mem/main/uninstall.sh | bash
```

Your memory data and settings in `~/.kimi-mem` are kept by default; add `--purge` (bash) / `-Purge` (PowerShell) to delete them too.

## Usage

### Compression model (slash command)

Inside a Kimi Code session:

- `/kimi-mem:model` — pops up an interactive picker with every model alias configured in `~/.kimi-code/config.toml` (`default_model`, `[secondary_model]`, all `[models.*]` entries, including third-party providers like deepseek); pick one to switch
- `/kimi-mem:model kimi-code/kimi-for-coding` — switch compression to that alias; takes effect immediately, no restart
- Empty (or a claude-style value like `haiku`/`claude-*`) = follow Kimi Code's `default_model`

### Searching memory

- Just ask, e.g. "how did we fix that login bug last time?" — the agent calls the MCP search tools automatically
- Three MCP tools in a token-saving workflow: `search` (index) → `timeline` (surrounding context) → `get_observations` (full details by ID)
- Or use the `/mem-search` skill explicitly

### Management commands

```bash
# from the repo checkout (default ~/.kimi-mem/repo)
bun plugin/scripts/worker-service.cjs kimi status        # plugin + worker status
bun plugin/scripts/worker-service.cjs kimi uninstall     # remove the plugin (keeps data)
bun plugin/scripts/worker-service.cjs start|stop|restart|status   # worker management
```

## How It Works

```
Kimi Code session
   │  hooks (declared by the plugin: SessionStart / UserPromptSubmit / PostToolUse / Stop)
   ▼
worker-service.cjs hook kimi <event>     ← fails silently, never blocks your session
   ▼
local worker daemon (HTTP API + web viewer)
   ▼
LLM compression ── default provider=kimi: headless kimi CLI calls, reusing your login and models
   ▼
SQLite (~/.kimi-mem/kimi-mem.db) + Chroma vector store
   ▼
next session's first prompt → relevant history injected
```

## Configuration

Settings file: `~/.kimi-mem/settings.json` (auto-created on first run).

### Compression provider

**Default `kimi`: reuse Kimi Code's models** — headless calls to your local `kimi` CLI, using your login and the models from `config.toml` (including third-party aliases you configured). **No API key needed:**

```json
"KIMI_MEM_PROVIDER": "kimi",
"KIMI_MEM_MODEL": ""            // empty = follow Kimi Code's default_model; an alias = kimi -m <alias>
```

**Optional: an independently-configured OpenAI-compatible API** (a separate Moonshot key, DeepSeek, a local LM Studio, etc.):

```json
"KIMI_MEM_PROVIDER": "openrouter",
"KIMI_MEM_OPENROUTER_API_KEY": "<your key>",
"KIMI_MEM_OPENROUTER_BASE_URL": "https://api.moonshot.cn/v1",
"KIMI_MEM_OPENROUTER_MODEL": "kimi-k2.6"
```

### Other common settings

| Setting | Description |
| --- | --- |
| `KIMI_MEM_DATA_DIR` | Data directory (default `~/.kimi-mem`) |
| `KIMI_MEM_MODE` | Language/workflow mode for generated observations; use `code--zh` for Chinese |
| `KIMI_MEM_WORKER_PORT` | Worker port (UID-derived by default, 377xx) |
| `KIMI_MEM_EXCLUDED_PROJECTS` | Comma-separated directories that are never recorded |
| `KIMI_CLI_PATH` | Manually point at the kimi CLI (auto-detected by default) |

## System Requirements

- **Node.js** ≥ 20
- **Kimi Code** (logged in)
- **Bun** (auto-installed by the one-click scripts)
- **uv** (optional, for Chroma vector search; auto-installed)

## Other Hosts

This fork keeps upstream support for Claude Code, Codex, Cursor, Windsurf, OpenCode and others (`npx kimi-mem install --ide <name>`, available once the npm package is published), but Kimi Code is the primary maintained and tested target.

## Development

```bash
npm install
npm run build          # regenerate plugin/scripts/*.cjs and other artifacts
npx tsc --noEmit       # typecheck
bun test tests         # tests
```

## License & Credits

[Apache License 2.0](../../LICENSE). Upstream project: [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman ([@thedotmack](https://github.com/thedotmack)).

- Issues: [GitHub Issues](https://github.com/YD-233/kimi-mem/issues)
