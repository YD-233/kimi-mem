#!/usr/bin/env bash

# Phase 10 — server-beta container entrypoint. The container ALWAYS runs the
# server-beta runtime; the legacy worker is never started here. Generation can
# be split into a separate `kimi-mem server worker start` process by setting
# KIMI_MEM_GENERATION_DISABLED=true on this service and running the worker
# command in a sibling container.

set -euo pipefail

mkdir -p "$HOME/.claude" "$HOME/.kimi-mem"

if [[ -n "${KIMI_MEM_CREDENTIALS_FILE:-}" ]]; then
  if [[ ! -f "$KIMI_MEM_CREDENTIALS_FILE" ]]; then
    echo "ERROR: KIMI_MEM_CREDENTIALS_FILE set but file missing: $KIMI_MEM_CREDENTIALS_FILE" >&2
    exit 1
  fi
  cp "$KIMI_MEM_CREDENTIALS_FILE" "$HOME/.claude/.credentials.json"
  chmod 600 "$HOME/.claude/.credentials.json"
fi

export PATH="/usr/local/bun/bin:/usr/local/share/npm-global/bin:$PATH"

# Mark this process tree as running inside Docker so server-beta env
# validation can refuse local-dev auth and require the full Postgres+Valkey
# configuration. /.dockerenv is also detected automatically; this is belt-
# and-suspenders for runtimes that don't expose it.
export KIMI_MEM_DOCKER=1
export KIMI_MEM_RUNTIME="${KIMI_MEM_RUNTIME:-server-beta}"

SERVER_BETA_SCRIPT="/opt/kimi-mem/scripts/server-service.cjs"

# Mode selection:
#   KIMI_MEM_CONTAINER_MODE=server (default) — HTTP server-beta, no worker
#   KIMI_MEM_CONTAINER_MODE=worker          — BullMQ generation worker only
#   KIMI_MEM_CONTAINER_MODE=shell           — fall through to "$@" for tooling
MODE="${KIMI_MEM_CONTAINER_MODE:-server}"

case "$MODE" in
  server)
    echo "[kimi-mem] starting server-beta runtime (HTTP, no legacy worker)" >&2
    exec bun "$SERVER_BETA_SCRIPT" --daemon
    ;;
  worker)
    echo "[kimi-mem] starting server-beta generation worker (no HTTP)" >&2
    # Force generation enabled in the worker process even if the env var was
    # set on the shared compose file; the worker IS the generation process.
    unset KIMI_MEM_GENERATION_DISABLED
    exec bun "$SERVER_BETA_SCRIPT" worker start
    ;;
  shell|tooling)
    if [[ $# -eq 0 ]]; then
      exec bash
    fi
    exec "$@"
    ;;
  *)
    echo "ERROR: unknown KIMI_MEM_CONTAINER_MODE=$MODE (expected: server, worker, shell)" >&2
    exit 1
    ;;
esac
