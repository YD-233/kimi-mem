/**
 * Kimi Code CLI discovery and validation — the `kimi` analog of
 * find-claude-executable.ts, used by KimiProvider to locate the CLI whose
 * configured model + auth the `kimi` compression provider reuses.
 *
 * Simpler than the Claude resolver: kimi-mem passes only stable flags
 * (`-p`, `--output-format`, `-m`), so a plain `--version` probe is enough —
 * there is no capability probe. Candidates are tried in a fixed TRUST ORDER
 * (known install locations first, then PATH order) and the first runnable one
 * wins — a "highest version wins" contest would let a planted binary rig the
 * outcome by printing a bigger number.
 *
 * Windows notes: Kimi Code's native installer drops `kimi.exe` under
 * ~/.kimi-code/bin; npm-style installs may only provide a `kimi.cmd` shim.
 * Node cannot execFile a .cmd directly (CVE-2024-27980), so .cmd candidates
 * always fail the probe and are never returned. And because `where` searches
 * the CURRENT directory before PATH, any `where`/`which` hit that resolves
 * inside the process cwd is excluded — a planted `kimi.exe` in a malicious
 * repo must never be spawned.
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, expandTilde } from './paths.js';
import { logger, type Component } from '../utils/logger.js';

/** Warm probes return in <1s; 10s only bites on cold-start / AV scans. */
const VERSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * findKimiExecutable() runs once per compression session; cache successes
 * briefly. Failures are never cached, so installing the CLI is picked up on
 * the next observation without a worker restart.
 */
const RESOLUTION_CACHE_TTL_MS = 15 * 60_000;

interface CachedResolution {
  path: string;
  version: string;
  expiresAtMs: number;
}

let cachedResolution: CachedResolution | null = null;

/** Test hook: clear the resolution cache between cases. */
export function resetKimiExecutableCache(): void {
  cachedResolution = null;
}

/**
 * Seam for unit tests — discovery and probing shell out to real binaries,
 * which tests replace by reassigning these members (no module mocking).
 */
export const _internals = {
  execSync,
  execFileSync,
  existsSync,
  homedir,
  platform: (): NodeJS.Platform => process.platform,
  cwd: (): string => process.cwd(),
  loadSettings: () => SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH),
};

type ProbeResult =
  | { kind: 'ok'; version: string }
  | { kind: 'broken'; detail: string };

/**
 * Run `<candidate> --version` and return trimmed stdout, or null on failure.
 * execFileSync (never a shell) so a crafted KIMI_CLI_PATH cannot smuggle
 * shell metacharacters into a command line.
 */
function probeCandidate(candidate: string): ProbeResult {
  try {
    const stdout = _internals.execFileSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_CHECK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (stdout) {
      return { kind: 'ok', version: stdout };
    }
    return { kind: 'broken', detail: 'empty --version output' };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const firstLine = String(stderr ?? (error instanceof Error ? error.message : error))
      .split('\n')[0]
      .trim();
    logger.debug('SDK', `Probe of "${candidate}" failed: ${firstLine || 'probe failed'}`, undefined, error);
    return { kind: 'broken', detail: firstLine || 'probe failed' };
  }
}

/**
 * True when `candidate` resolves inside the process cwd. `where` (Windows)
 * searches the current directory before PATH, and `which -a` finds cwd
 * entries when PATH contains `.` — both let a planted binary in a malicious
 * repo win discovery, so such hits are dropped before probing.
 */
function isInsideCwd(candidate: string): boolean {
  let base = resolve(_internals.cwd());
  let target = resolve(candidate);
  if (_internals.platform() === 'win32') {
    base = base.toLowerCase();
    target = target.toLowerCase();
  }
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * All places a Kimi CLI might live, best-effort and deduplicated, in fixed
 * trust order:
 *   1. the native installer's bin dir (~/.kimi-code/bin) — may not be on the
 *      worker's PATH depending on how the daemon was spawned
 *   2. PATH matches (`which -a` / `where`), in reported order, excluding any
 *      hit that resolves inside the current directory
 *   3. other known install locations (~/.local/bin)
 */
function discoverCandidates(): string[] {
  const candidates: string[] = [];

  if (_internals.platform() === 'win32') {
    candidates.push(join(_internals.homedir(), '.kimi-code', 'bin', 'kimi.exe'));
    // kimi.exe first: a native binary spawns without the cmd.exe wrapper (and
    // without its 8191-char command-line limit); .cmd shims also fail the
    // execFile probe, so listing them first would just waste a spawn.
    for (const command of ['where kimi.exe', 'where kimi.cmd', 'where kimi']) {
      try {
        const output = _internals.execSync(command, {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        for (const line of output.split('\n').map((l) => l.trim()).filter(Boolean)) {
          if (isInsideCwd(line)) continue; // cwd-resident hit — not from PATH
          candidates.push(line);
        }
      } catch {
        // Not found via this lookup — try the next discovery source.
      }
    }
  } else {
    candidates.push(join(_internals.homedir(), '.kimi-code', 'bin', 'kimi'));
    try {
      const output = _internals.execSync('which -a kimi', {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of output.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (isInsideCwd(line)) continue; // cwd-resident hit — not from PATH
        candidates.push(line);
      }
    } catch {
      // which -a found nothing — known install locations below still apply.
    }
    candidates.push(join(_internals.homedir(), '.local', 'bin', 'kimi'));
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of candidates) {
    const key = _internals.platform() === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

/**
 * Find and validate a Kimi Code CLI executable.
 *
 * Discovery order:
 *   1. `KIMI_CLI_PATH` from settings.json (explicit user override — wins,
 *      but fails loud if it cannot run rather than dying silently at spawn)
 *   2. Candidates in trust order (~/.kimi-code/bin, then PATH matches with
 *      cwd-resident hits excluded, then other known locations), each probed
 *      with `--version`; the FIRST runnable candidate wins
 *
 * @param logComponent  Logger {@link Component} tag (e.g. 'SDK', 'WORKER')
 * @throws {Error} when no runnable Kimi CLI can be found
 */
export function findKimiExecutable(logComponent: Component = 'SDK'): string {
  if (cachedResolution && cachedResolution.expiresAtMs > Date.now() && _internals.existsSync(cachedResolution.path)) {
    return cachedResolution.path;
  }
  cachedResolution = null;

  const settings = _internals.loadSettings();

  // --- 1. Explicit configured path ----------------------------------------
  if (settings.KIMI_CLI_PATH) {
    // Nothing here runs through a shell — expand a literal `~` defensively so
    // both the existence check and the probe see a real absolute path.
    const configuredPath = expandTilde(settings.KIMI_CLI_PATH, _internals.homedir());
    if (!_internals.existsSync(configuredPath)) {
      throw new Error(
        `KIMI_CLI_PATH is set to "${settings.KIMI_CLI_PATH}" but the file does not exist.`
      );
    }

    const probe = probeCandidate(configuredPath);
    if (probe.kind === 'ok') {
      logger.info(logComponent, `Using configured KIMI_CLI_PATH: ${configuredPath} (${probe.version})`);
      cachedResolution = {
        path: configuredPath,
        version: probe.version,
        expiresAtMs: Date.now() + RESOLUTION_CACHE_TTL_MS,
      };
      return configuredPath;
    }
    throw new Error(
      `KIMI_CLI_PATH is set to "${settings.KIMI_CLI_PATH}" but it failed the --version check (${probe.detail}). ` +
      `Ensure this is a working Kimi Code CLI binary.`
    );
  }

  // --- 2. Probe every discovered candidate ---------------------------------
  const candidates = discoverCandidates();
  // Trust order, first runnable candidate wins — no version comparison:
  // "highest --version wins" lets a planted binary rig the contest by
  // printing a bigger number.
  for (const candidate of candidates) {
    if (!_internals.existsSync(candidate)) continue;
    const probe = probeCandidate(candidate);

    if (probe.kind === 'ok') {
      logger.info(logComponent, `Using Kimi CLI v${probe.version} at ${candidate}`, {
        candidatesProbed: candidates.length,
      });
      cachedResolution = {
        path: candidate,
        version: probe.version,
        expiresAtMs: Date.now() + RESOLUTION_CACHE_TTL_MS,
      };
      return candidate;
    } else {
      logger.debug(logComponent, `Skipping "${candidate}" — failed --version check (${probe.detail})`);
    }
  }

  throw new Error(
    'Kimi executable not found. The "kimi" compression provider runs your local Kimi Code CLI. Please either:\n' +
    '1. Install Kimi Code and add "kimi" to your system PATH, or\n' +
    '2. Set KIMI_CLI_PATH in ~/.kimi-mem/settings.json'
  );
}
