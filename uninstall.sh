#!/usr/bin/env bash
# kimi-mem one-click uninstaller for Linux / macOS / Git Bash.
#
#   curl -fsSL https://raw.githubusercontent.com/YD-233/kimi-mem/main/uninstall.sh | bash
#
# What it does:
#   1. Stops the kimi-mem worker daemon.
#   2. Removes the plugin from Kimi Code (plugins/managed/kimi-mem + the
#      plugins/installed.json record; other plugins are preserved).
#   3. Deletes the repo checkout (~/.kimi-mem/repo).
#
# Your memory data and settings (~/.kimi-mem, minus the repo) are KEPT by
# default. Pass --purge to delete them too (includes the memory database and
# settings.json with your API key — irreversible).
#
# Overrides (env): KIMI_MEM_REPO_DIR, KIMI_MEM_DATA_DIR, KIMI_CODE_HOME
set -euo pipefail

REPO_DIR="${KIMI_MEM_REPO_DIR:-$HOME/.kimi-mem/repo}"
DATA_DIR="${KIMI_MEM_DATA_DIR:-$HOME/.kimi-mem}"
KIMI_HOME="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

say() { printf '[kimi-mem] %s\n' "$*"; }

# Safety: never rm -rf a directory whose basename doesn't match the shape we
# expect — a stray KIMI_MEM_DATA_DIR=$HOME (or /) with --purge would
# otherwise delete the user's home directory. basename collapses trailing
# slashes; a root path yields '/' and is refused.
REFUSED=0
guard_basename() {
  # $1 = target dir, $2 = expected basename, $3 = human label
  local base
  base="$(basename "$1")"
  if [ "$base" != "$2" ]; then
    say "REFUSING to remove $3: '$1' is not a '$2' directory. Fix the env override and re-run."
    REFUSED=1
    return 1
  fi
  return 0
}

# Locate a worker-service.cjs we can run: prefer the repo checkout, fall back
# to the managed plugin copy inside Kimi Code.
WS=""
for candidate in \
  "$REPO_DIR/plugin/scripts/worker-service.cjs" \
  "$KIMI_HOME/plugins/managed/kimi-mem/scripts/worker-service.cjs"; do
  if [ -f "$candidate" ]; then WS="$candidate"; break; fi
done

if [ -z "$WS" ]; then
  say "No kimi-mem installation found (no repo checkout, no managed plugin)."
else
  BUN="$(command -v bun || true)"
  [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
  [ -z "$BUN" ] && BUN="bun"   # let it fail with a clear message if truly absent

  say "Stopping the worker ..."
  "$BUN" "$WS" stop >/dev/null 2>&1 || true

  say "Removing the Kimi Code plugin ..."
  "$BUN" "$WS" kimi uninstall || say "kimi uninstall reported a problem; continuing."
fi

# Belt and braces: the managed copy should be gone already; make sure.
MANAGED_DIR="$KIMI_HOME/plugins/managed/kimi-mem"
if [ -d "$MANAGED_DIR" ]; then
  if guard_basename "$MANAGED_DIR" "kimi-mem" "managed plugin copy"; then
    rm -rf "$MANAGED_DIR" && say "Removed leftover managed plugin copy."
  fi
fi

if [ -d "$REPO_DIR" ]; then
  if guard_basename "$REPO_DIR" "repo" "repo checkout"; then
    rm -rf "$REPO_DIR" && say "Removed repo checkout $REPO_DIR."
  fi
fi

if [ "$PURGE" -eq 1 ]; then
  if [ -d "$DATA_DIR" ]; then
    if guard_basename "$DATA_DIR" ".kimi-mem" "data directory"; then
      rm -rf "$DATA_DIR" && say "Purged data directory $DATA_DIR."
    fi
  fi
else
  [ -d "$DATA_DIR" ] && say "Kept data directory $DATA_DIR (memory database + settings). Re-run with --purge to delete it."
fi

say "Done. Restart Kimi Code (or run /reload) to unload the plugin."
exit "$REFUSED"
