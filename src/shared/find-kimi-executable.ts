/**
 * Kimi Code CLI discovery and validation — the `kimi` analog of
 * find-claude-executable.ts, used by KimiProvider to locate the CLI whose
 * configured model + auth the `kimi` compression provider reuses.
 *
 * Simpler than the Claude resolver: kimi-mem passes only stable flags
 * (`-p`, `--output-format`, `-m`), so a plain `--version` probe is enough —
 * there is no capability probe. When several candidates are installed, the
 * NEWEST responding version wins; PATH order is only a tie-breaker.
 *
 * Windows note: Kimi Code's native installer drops `kimi.exe` under
 * ~/.kimi-code/bin; npm-style installs may only provide a `kimi.cmd` shim.
 * Node cannot execFile a .cmd directly (CVE-2024-27980), so .cmd candidates
 * fail the probe and lose to any real .exe — the provider's spawn path still
 * supports a resolved .cmd via the cmd.exe wrapper (see KimiProvider).
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
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

/** Parse "0.34.0" → [0, 34, 0]; unparseable sorts lowest. */
function parseVersionKey(version: string): [number, number, number] {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionKeysDesc(a: [number, number, number], b: [number, number, number]): number {
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}

/**
 * All places a Kimi CLI might live, best-effort and deduplicated:
 *   - every PATH match (`which -a` / `where`), not just the first
 *   - the native installer's bin dir (~/.kimi-code/bin), which may not be on
 *     the worker's PATH depending on how the daemon was spawned
 */
function discoverCandidates(): string[] {
  const candidates: string[] = [];

  if (_internals.platform() === 'win32') {
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
        candidates.push(...output.split('\n').map((line) => line.trim()).filter(Boolean));
      } catch {
        // Not found via this lookup — try the next discovery source.
      }
    }
    candidates.push(join(_internals.homedir(), '.kimi-code', 'bin', 'kimi.exe'));
  } else {
    try {
      const output = _internals.execSync('which -a kimi', {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      candidates.push(...output.split('\n').map((line) => line.trim()).filter(Boolean));
    } catch {
      // which -a found nothing — known install locations below still apply.
    }
    candidates.push(join(_internals.homedir(), '.kimi-code', 'bin', 'kimi'));
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
 *   2. Every `kimi` on PATH plus known install locations, probed with
 *      `--version`; the newest responding version is returned
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
  const capable: Array<{ path: string; version: string; key: [number, number, number]; order: number }> = [];

  const candidates = discoverCandidates();
  for (let order = 0; order < candidates.length; order++) {
    const candidate = candidates[order];
    if (!_internals.existsSync(candidate)) continue;
    const probe = probeCandidate(candidate);

    if (probe.kind === 'ok') {
      capable.push({ path: candidate, version: probe.version, key: parseVersionKey(probe.version), order });
    } else {
      logger.debug(logComponent, `Skipping "${candidate}" — failed --version check (${probe.detail})`);
    }
  }

  if (capable.length > 0) {
    capable.sort((a, b) => compareVersionKeysDesc(a.key, b.key) || a.order - b.order);
    const winner = capable[0];
    logger.info(logComponent, `Using Kimi CLI v${winner.version} at ${winner.path}`, {
      candidatesProbed: candidates.length,
    });
    cachedResolution = {
      path: winner.path,
      version: winner.version,
      expiresAtMs: Date.now() + RESOLUTION_CACHE_TTL_MS,
    };
    return winner.path;
  }

  throw new Error(
    'Kimi executable not found. The "kimi" compression provider runs your local Kimi Code CLI. Please either:\n' +
    '1. Install Kimi Code and add "kimi" to your system PATH, or\n' +
    '2. Set KIMI_CLI_PATH in ~/.kimi-mem/settings.json'
  );
}
