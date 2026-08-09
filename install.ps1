# kimi-mem one-click installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/YD-233/kimi-mem/main/install.ps1 | iex
#
# What it does:
#   1. Ensures node (>= 20) and bun are available (auto-installs bun if missing).
#   2. Clones (or updates) the kimi-mem repo into ~\.kimi-mem\repo.
#   3. Runs `worker-service.cjs kimi install`, which copies the bundled plugin
#      into $KIMI_CODE_HOME\plugins\managed\kimi-mem\ and registers it in
#      plugins\installed.json.
#
# Overrides (env): KIMI_MEM_REPO_URL, KIMI_MEM_REPO_DIR, KIMI_CODE_HOME,
#                  KIMI_MEM_DATA_DIR
$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:KIMI_MEM_REPO_URL) { $env:KIMI_MEM_REPO_URL } else { 'https://github.com/YD-233/kimi-mem.git' }
$Home_   = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$RepoDir = if ($env:KIMI_MEM_REPO_DIR) { $env:KIMI_MEM_REPO_DIR } else { Join-Path $Home_ '.kimi-mem\repo' }

function Say($msg)  { Write-Host "[kimi-mem] $msg" }
function Fail($msg) { Write-Host "[kimi-mem] ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- node >= 20 (required by the plugin's mcp server and bun-runner) ---------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node not found. Install Node.js >= 20 first: https://nodejs.org/' }
$nodeVersion = (node -v)
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { Fail "node $nodeVersion is too old; need >= 20." }
Say "node $nodeVersion OK"

# --- bun (required to run the worker service) --------------------------------
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Say 'bun not found; installing via https://bun.sh/install.ps1 ...'
  irm bun.sh/install.ps1 | iex
  $env:Path = "$Home_\.bun\bin;$env:Path"
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Fail 'bun installation failed; install it manually: https://bun.sh/' }
}
Say "bun $(bun --version) OK"

# --- repo checkout ------------------------------------------------------------
if (Test-Path $RepoDir) {
  if (Test-Path (Join-Path $RepoDir '.git')) {
    Say "Updating existing checkout at $RepoDir ..."
    git -C $RepoDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Say 'git pull failed; continuing with existing checkout.' }
  } else {
    Say "Using existing directory $RepoDir (not a git repo; skipping update)."
  }
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git not found; install git or set KIMI_MEM_REPO_DIR to an existing checkout.' }
  Say "Cloning $RepoUrl -> $RepoDir ..."
  New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir -Parent) | Out-Null
  git clone --depth 1 $RepoUrl $RepoDir
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.' }
}

# --- install the Kimi Code plugin --------------------------------------------
Say 'Installing the kimi-mem plugin into Kimi Code ...'
& bun (Join-Path $RepoDir 'plugin\scripts\worker-service.cjs') kimi install
if ($LASTEXITCODE -ne 0) { Fail "kimi install exited with code $LASTEXITCODE" }

# --- restart a running worker so it picks up the updated code -----------------
$ws = Join-Path $RepoDir 'plugin\scripts\worker-service.cjs'
if ((& bun $ws status 2>$null | Out-String) -match 'Worker is running') {
  Say 'Restarting the worker to pick up updates ...'
  try { & bun $ws restart 2>&1 | Out-Null } catch {}
}

Write-Host @"

[kimi-mem] Done. Next steps:
  1. Restart Kimi Code (or run /reload) so the plugin loads.
  2. Compression uses your logged-in Kimi Code CLI by default — no API key
     needed. Optional: switch the model with /kimi-mem:model <alias>.
  3. Optional: use an independent OpenAI-compatible API instead — set
       "KIMI_MEM_PROVIDER": "openrouter",
       "KIMI_MEM_OPENROUTER_API_KEY": "<your key>"
     (plus KIMI_MEM_OPENROUTER_BASE_URL / KIMI_MEM_OPENROUTER_MODEL if needed)
     in ~\.kimi-mem\settings.json.

Manage later with:
  bun "$RepoDir\plugin\scripts\worker-service.cjs" kimi status|uninstall
"@
