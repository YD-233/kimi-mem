# kimi-mem one-click uninstaller for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/YD-233/kimi-mem/main/uninstall.ps1 | iex
#
# What it does:
#   1. Stops the kimi-mem worker daemon.
#   2. Removes the plugin from Kimi Code (plugins\managed\kimi-mem + the
#      plugins\installed.json record; other plugins are preserved).
#   3. Deletes the repo checkout (~\.kimi-mem\repo).
#
# Your memory data and settings (~\.kimi-mem, minus the repo) are KEPT by
# default. Use -Purge to delete them too (includes the memory database and
# settings.json with your API key — irreversible):
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/YD-233/kimi-mem/main/uninstall.ps1))) -Purge
#
# Overrides (env): KIMI_MEM_REPO_DIR, KIMI_MEM_DATA_DIR, KIMI_CODE_HOME
param([switch]$Purge)
$ErrorActionPreference = 'Stop'

$Home_    = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$RepoDir  = if ($env:KIMI_MEM_REPO_DIR)  { $env:KIMI_MEM_REPO_DIR }  else { Join-Path $Home_ '.kimi-mem\repo' }
$DataDir  = if ($env:KIMI_MEM_DATA_DIR)  { $env:KIMI_MEM_DATA_DIR }  else { Join-Path $Home_ '.kimi-mem' }
$KimiHome = if ($env:KIMI_CODE_HOME)     { $env:KIMI_CODE_HOME }     else { Join-Path $Home_ '.kimi-code' }

function Say($msg) { Write-Host "[kimi-mem] $msg" }

# Locate a worker-service.cjs we can run: prefer the repo checkout, fall back
# to the managed plugin copy inside Kimi Code.
$Ws = $null
foreach ($candidate in @(
  (Join-Path $RepoDir 'plugin\scripts\worker-service.cjs'),
  (Join-Path $KimiHome 'plugins\managed\kimi-mem\scripts\worker-service.cjs')
)) { if (Test-Path $candidate) { $Ws = $candidate; break } }

if (-not $Ws) {
  Say 'No kimi-mem installation found (no repo checkout, no managed plugin).'
} else {
  $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
  $bun = if ($bunCmd) { $bunCmd.Source } elseif (Test-Path "$Home_\.bun\bin\bun.exe") { "$Home_\.bun\bin\bun.exe" } else { 'bun' }

  Say 'Stopping the worker ...'
  try { & $bun $Ws stop 2>&1 | Out-Null } catch {}

  Say 'Removing the Kimi Code plugin ...'
  & $bun $Ws kimi uninstall
  if ($LASTEXITCODE -ne 0) { Say 'kimi uninstall reported a problem; continuing.' }
}

# Belt and braces: the managed copy should be gone already; make sure.
$managed = Join-Path $KimiHome 'plugins\managed\kimi-mem'
if (Test-Path $managed) {
  Remove-Item -Recurse -Force $managed
  Say 'Removed leftover managed plugin copy.'
}

if (Test-Path $RepoDir) {
  Remove-Item -Recurse -Force $RepoDir
  Say "Removed repo checkout $RepoDir."
}

if ($Purge) {
  if (Test-Path $DataDir) {
    Remove-Item -Recurse -Force $DataDir
    Say "Purged data directory $DataDir."
  }
} elseif (Test-Path $DataDir) {
  Say "Kept data directory $DataDir (memory database + settings). Re-run with -Purge to delete it."
}

Say 'Done. Restart Kimi Code (or run /reload) to unload the plugin.'
