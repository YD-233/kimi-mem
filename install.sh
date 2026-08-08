#!/usr/bin/env bash
# kimi-mem one-click installer for Linux / macOS / Git Bash.
#
#   curl -fsSL https://raw.githubusercontent.com/YD-233/kimi-mem/main/install.sh | bash
#
# What it does:
#   1. Ensures node (>= 20) and bun are available (auto-installs bun if missing).
#   2. Clones (or updates) the kimi-mem repo into ~/.kimi-mem/repo.
#   3. Runs `worker-service.cjs kimi install`, which copies the bundled plugin
#      into $KIMI_CODE_HOME/plugins/managed/kimi-mem/ and registers it in
#      plugins/installed.json.
#
# Overrides (env): KIMI_MEM_REPO_URL, KIMI_MEM_REPO_DIR, KIMI_CODE_HOME,
#                  KIMI_MEM_DATA_DIR
set -euo pipefail

REPO_URL="${KIMI_MEM_REPO_URL:-https://github.com/YD-233/kimi-mem.git}"
REPO_DIR="${KIMI_MEM_REPO_DIR:-$HOME/.kimi-mem/repo}"

say()  { printf '[kimi-mem] %s\n' "$*"; }
fail() { printf '[kimi-mem] ERROR: %s\n' "$*" >&2; exit 1; }

# --- node >= 20 (required by the plugin's mcp server and bun-runner) ---------
if ! command -v node >/dev/null 2>&1; then
  fail "node not found. Install Node.js >= 20 first: https://nodejs.org/"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "node $(node -v) is too old; need >= 20."
say "node $(node -v) OK"

# --- bun (required to run the worker service) --------------------------------
if ! command -v bun >/dev/null 2>&1; then
  say "bun not found; installing via https://bun.sh/install ..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || fail "bun installation failed; install it manually: https://bun.sh/"
fi
say "bun $(bun --version) OK"

# --- repo checkout ------------------------------------------------------------
if [ -d "$REPO_DIR" ]; then
  if [ -d "$REPO_DIR/.git" ]; then
    say "Updating existing checkout at $REPO_DIR ..."
    git -C "$REPO_DIR" pull --ff-only || say "git pull failed; continuing with existing checkout."
  else
    say "Using existing directory $REPO_DIR (not a git repo; skipping update)."
  fi
else
  command -v git >/dev/null 2>&1 || fail "git not found; install git or set KIMI_MEM_REPO_DIR to an existing checkout."
  say "Cloning $REPO_URL -> $REPO_DIR ..."
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
fi

# --- install the Kimi Code plugin --------------------------------------------
say "Installing the kimi-mem plugin into Kimi Code ..."
bun "$REPO_DIR/plugin/scripts/worker-service.cjs" kimi install

# --- restart a running worker so it picks up the updated code -----------------
if bun "$REPO_DIR/plugin/scripts/worker-service.cjs" status 2>/dev/null | grep -q "Worker is running"; then
  say "Restarting the worker to pick up updates ..."
  bun "$REPO_DIR/plugin/scripts/worker-service.cjs" restart >/dev/null 2>&1 || true
fi

cat <<EOF

[kimi-mem] Done. Next steps:
  1. Add your Moonshot API key to ~/.kimi-mem/settings.json:
       "KIMI_MEM_OPENROUTER_API_KEY": "<your key>"   (https://platform.moonshot.cn/)
  2. Restart Kimi Code (or run /reload) so the plugin loads.
  3. Optional: change the compression model inside Kimi Code with
       /kimi-mem:model <model-id>   (default: kimi-k2.6)

Manage later with:
  bun "$REPO_DIR/plugin/scripts/worker-service.cjs" kimi status|uninstall
EOF
