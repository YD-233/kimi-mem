# Kimi-Mem: AI Development Instructions

Kimi-Mem is a Kimi Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Kimi Code CLI (or an OpenAI-compatible API), and injects relevant context into future sessions.

## Build

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `$KIMI_CODE_HOME/plugins/managed/kimi-mem/`
- **Database**: `~/.kimi-mem/kimi-mem.db`
- **Chroma**: `~/.kimi-mem/chroma/`

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Docs**: This fork does not deploy the docs site — see the GitHub repo: https://github.com/YD-233/kimi-mem
**Source**: `docs/public/` - upstream MDX files, kept for reference (not deployed)

## Important

No need to edit the changelog ever, it's generated automatically.
