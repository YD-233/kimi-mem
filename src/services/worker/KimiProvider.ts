/**
 * KimiProvider.ts — compression provider that reuses the user's local Kimi
 * Code CLI (`kimi -p`) instead of an HTTP API. The CLI already carries the
 * user's configured model (`default_model` in ~/.kimi-code/config.toml) and
 * login (managed OAuth), so this provider needs no API key.
 *
 * Session lifecycle (init prompt, observation/summary loop, history
 * bookkeeping) is inherited from OpenAICompatibleProvider; the per-turn
 * transport is a headless CLI spawn instead of a fetch:
 *
 *   kimi -p <flattened history> --output-format stream-json [-m <alias>]
 *
 * Design notes:
 * - `stream-json` (NDJSON: {"role":"assistant","content":...} per line) is
 *   used instead of the default `text` format because `text` renders the
 *   reply as a bullet block ("• " first line, two-space indented rest),
 *   which corrupts markdown indentation. NDJSON carries the exact content.
 * - Every spawn is stateless (no `kimi -S` resume): the full conversation
 *   history is flattened into each prompt, exactly like the HTTP providers
 *   POST their full messages array. Trade-off: per-call latency/token cost
 *   grows with history length, and each call leaves a session entry under
 *   ~/.kimi-code.
 * - Recursion guard: the child env gets KIMI_MEM_INTERNAL=1 via
 *   buildIsolatedEnv(false) so a nested `kimi -p` session's hooks no-op
 *   (shouldTrackProject returns false) instead of re-triggering kimi-mem.
 * - Model mapping: claude-ish values (haiku/sonnet/opus aliases, `claude-*`
 *   ids — the factory KIMI_MEM_MODEL/tier defaults) are meaningless to the
 *   kimi CLI and map to "no -m flag" (use the CLI's own default_model). Any
 *   other value passes through as `kimi -m <alias>`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths, OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import { buildIsolatedEnv } from '../../shared/EnvManager.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { findKimiExecutable } from '../../shared/find-kimi-executable.js';
import { clearDependencyStatus, recordKimiCliSetupRequired } from '../../shared/dependency-health.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { resolveTierAlias } from './model-aliases.js';

/**
 * Per-attempt wall-clock budget for one `kimi -p` call. Far above the HTTP
 * providers' 30s default: CLI cold start plus a compression response on a
 * subscription model routinely takes 30–90s.
 */
const KIMI_CLI_PER_ATTEMPT_TIMEOUT_MS = 180_000;

/**
 * Budget for the flattened prompt. The two platforms measure DIFFERENTLY:
 * Windows caps a CreateProcess command line at 32767 UTF-16 code units, so
 * there the budget is 24k chars (headroom for the executable path and
 * flags); POSIX MAX_ARG_STRLEN is a per-arg BYTE limit (128KB), so the budget
 * is ~100KB measured with Buffer.byteLength — 120k CJK chars are ~360KB of
 * UTF-8 and would E2BIG every spawn. The newest turn is never truncated —
 * when even it exceeds the budget it is sent whole and any OS-level failure
 * surfaces as a classified spawn error.
 */
const FLATTENED_PROMPT_MAX_CHARS_WIN32 = 24_000;
const FLATTENED_PROMPT_MAX_BYTES_POSIX = 100_000;

/** Claude-ish model values that mean "no override" for the kimi CLI. */
const CLAUDE_TIER_ALIASES = new Set(['haiku', 'sonnet', 'opus']);

/**
 * Map a configured model value to a `kimi -m` argument. Returns null for
 * empty and claude-ish values (factory defaults like 'haiku' or
 * 'claude-haiku-4-5-20251001') so the CLI falls back to the user's own
 * default_model; anything else (e.g. 'kimi-code/kimi-for-coding') passes
 * through verbatim.
 */
export function resolveKimiModelArg(model: string | null | undefined): string | null {
  const value = (model ?? '').trim();
  if (!value) return null;
  if (CLAUDE_TIER_ALIASES.has(value)) return null;
  if (value.startsWith('claude-')) return null;
  return value;
}

/**
 * Flatten the multi-turn conversation history into one prompt for the
 * stateless CLI call. Roles are labeled ("User:"/"Assistant:") so the model
 * can tell instructions from its own earlier replies. When the total exceeds
 * the budget, oldest turns are elided (newest-first fill) with a marker —
 * the newest turn is the live instruction and is always kept whole.
 *
 * The budget unit is explicit: Windows command lines are char-capped, POSIX
 * MAX_ARG_STRLEN is byte-capped, so POSIX callers pass 'bytes' and the turn
 * cost is measured with Buffer.byteLength (CJK text is 3 bytes/char).
 */
export function flattenHistoryForPrompt(
  history: ConversationMessage[],
  maxSize: number,
  unit: 'chars' | 'bytes' = 'chars',
): string {
  const measure = (text: string): number =>
    unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : text.length;

  const turns = history
    .filter(message => message.content.trim().length > 0)
    .map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}:\n${message.content.trim()}`);

  const joined = turns.join('\n\n');
  if (measure(joined) <= maxSize) return joined;

  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = measure(turns[i]) + 2; // '\n\n' separator (2 chars = 2 bytes)
    if (kept.length > 0 && used + cost > maxSize) break;
    kept.unshift(turns[i]);
    used += cost;
    if (used > maxSize) break; // newest turn alone over budget — kept whole
  }

  const elided = turns.length - kept.length;
  const marker = elided > 0
    ? `[... ${elided} earlier turn(s) elided to fit the kimi CLI prompt budget ...]\n\n`
    : '';
  return marker + kept.join('\n\n');
}

export interface KimiStreamJsonParseResult {
  content: string;
  sessionId?: string;
}

/**
 * Parse `--output-format stream-json` stdout: concatenate every assistant
 * event's content (a tool-using reply can span several), and lift the
 * session id from the resume-hint meta line for debuggability. Non-JSON
 * lines (shouldn't exist on stdout, but defensive) are ignored.
 */
export function parseStreamJsonStdout(stdout: string): KimiStreamJsonParseResult {
  const parts: string[] = [];
  let sessionId: string | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { role?: string; type?: string; content?: unknown; session_id?: unknown };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.role === 'assistant' && typeof event.content === 'string') {
      parts.push(event.content);
    } else if (event.type === 'session.resume_hint' && typeof event.session_id === 'string') {
      sessionId = event.session_id;
    }
  }

  return { content: parts.join('\n'), ...(sessionId ? { sessionId } : {}) };
}

/**
 * Classify a `kimi -p` spawn failure. Provider-specific because failure
 * signals are process-level (exit code, signal, stderr wording) rather than
 * HTTP status codes. Kept deliberately simple: unknown non-zero exits are
 * transient (retryable), matching the "retry what isn't clearly permanent"
 * default of the other providers.
 */
export function classifyKimiError(input: {
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string;
  cause: unknown;
}): ClassifiedProviderError {
  const stderr = input.stderr ?? '';
  const lower = stderr.toLowerCase();
  const causeMessage = input.cause instanceof Error ? input.cause.message : String(input.cause);
  const summary = stderr.trim().split('\n')[0] || causeMessage;

  // Executable / spawn issues — unrecoverable until the user fixes the setup.
  if (
    causeMessage.includes('Kimi executable not found') ||
    causeMessage.includes('KIMI_CLI_PATH') ||
    causeMessage.includes('ENOENT')
  ) {
    return new ClassifiedProviderError(causeMessage, { kind: 'setup_required', cause: input.cause });
  }

  // Auth — the CLI manages login itself; a 401/403 means re-login is required.
  // Status codes match on word boundaries only: substring matching would
  // misclassify payloads like "1401 bytes written" or "4039 retries" as
  // non-retryable auth failures.
  if (
    /\b40[13]\b/.test(lower) ||
    lower.includes('unauthorized') || lower.includes('authentication') ||
    lower.includes('not logged in') || lower.includes('login required')
  ) {
    return new ClassifiedProviderError(
      `kimi CLI auth error — run \`kimi login\` to re-authenticate (${summary})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  // Quota — anchored forms so "insufficient memory" and friends stay
  // transient/retryable instead of being parked as quota_exhausted.
  if (/\bquota\b/.test(lower) || /insufficient\s+(balance|funds|credits)/.test(lower)) {
    return new ClassifiedProviderError(
      `kimi CLI quota exhausted (${summary})`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (lower.includes('rate limit') || /\b429\b/.test(lower) || lower.includes('too many requests')) {
    return new ClassifiedProviderError(
      `kimi CLI rate limit (${summary})`,
      { kind: 'rate_limit', cause: input.cause },
    );
  }

  // Context overflow — retrying the same flattened history can never succeed.
  if (
    lower.includes('context window') || lower.includes('context length') ||
    lower.includes('prompt is too long') || lower.includes('too many tokens')
  ) {
    return new ClassifiedProviderError(
      `kimi CLI context overflow (${summary})`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (input.signal) {
    return new ClassifiedProviderError(
      `kimi CLI killed by signal ${input.signal}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `kimi CLI exited with code ${input.exitCode ?? 'unknown'}${summary ? `: ${summary}` : ''}`,
    { kind: 'transient', cause: input.cause },
  );
}

interface KimiConfig {
  /**
   * The resolved CLI path doubles as the "credential": kimi CLI auth is
   * managed by the CLI itself (managed OAuth), so the only thing a session
   * cannot start without is the executable. Empty string → setup_required.
   */
  apiKey: string;
  /** Raw configured model string (pre -m mapping); display/telemetry value. */
  model: string;
  cliPath: string;
}

interface KimiCliRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Seam for unit tests — spawning touches real processes, which tests replace
 * by reassigning these members (same pattern as find-claude-executable).
 */
export const _internals = {
  spawnProcess: spawn,
  processKill: (pid: number, signal: NodeJS.Signals): void => { process.kill(pid, signal); },
  findKimiCli: findKimiExecutable,
  buildChildEnv: (): Record<string, string> => {
    // buildIsolatedEnv(false): sanitized parent env minus credential injection,
    // plus KIMI_MEM_INTERNAL=1 (the nested-session recursion guard).
    // sanitizeEnv strips CLAUDE_CODE_* on top, matching the SDK spawn path.
    return sanitizeEnv(buildIsolatedEnv(false)) as Record<string, string>;
  },
  platform: (): NodeJS.Platform => process.platform,
  perAttemptTimeoutMs: KIMI_CLI_PER_ATTEMPT_TIMEOUT_MS,
  flattenedPromptBudget: (): { maxSize: number; unit: 'chars' | 'bytes' } =>
    (process.platform === 'win32'
      ? { maxSize: FLATTENED_PROMPT_MAX_CHARS_WIN32, unit: 'chars' }
      : { maxSize: FLATTENED_PROMPT_MAX_BYTES_POSIX, unit: 'bytes' }),
};

/** Grace period before a POSIX group SIGTERM escalates to SIGKILL. */
const TREE_KILL_GRACE_MS = 2_000;

/**
 * Cap on collected stdout/stderr per attempt (~10MB). A misbehaving binary
 * writing an endless stream would otherwise grow these strings until the
 * worker OOMs.
 */
const MAX_COLLECTED_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Kill the CLI's whole process tree, not just the direct child: `kimi -p`
 * may spawn its own helpers, and a bare child.kill() would orphan them
 * holding the stdio pipes open. Windows uses `taskkill /T /F`; POSIX signals
 * the child's process group (the spawn is detached, so the child leads its
 * own group) with a SIGKILL escalation after a short grace.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try { child.kill('SIGKILL'); } catch { /* best-effort */ }
    return;
  }
  if (_internals.platform() === 'win32') {
    try {
      const taskkill = _internals.spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkill.unref();
    } catch { /* best-effort */ }
    return;
  }
  try { _internals.processKill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* best-effort */ } }
  const escalation = setTimeout(() => {
    try { _internals.processKill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* best-effort */ } }
  }, TREE_KILL_GRACE_MS);
  escalation.unref();
}

/**
 * Spawn the CLI with an argument vector. The resolved path is always a real
 * binary — .cmd shims can never win discovery because the --version probe
 * (execFile, no shell) cannot run them — so there is deliberately no cmd.exe
 * wrapper branch. POSIX spawns are detached so the child leads its own
 * process group and the timeout path can kill the whole tree with a
 * negative-pid group signal (see killProcessTree).
 */
function spawnKimiCli(cliPath: string, args: string[], env: Record<string, string>): ChildProcess {
  // Run the nested session from the observer-sessions dir, not the worker's
  // inherited cwd: kimi would otherwise auto-load that project (AGENTS.md,
  // skills, .kimi-code config) into every compression prompt — nondeterministic
  // noise. As a side effect the cwd also sits inside the shouldTrackProject
  // exclusion zone, a second recursion-guard layer under KIMI_MEM_INTERNAL=1.
  ensureDir(OBSERVER_SESSIONS_DIR);
  const cwd = OBSERVER_SESSIONS_DIR;

  return _internals.spawnProcess(cliPath, args, {
    env,
    cwd,
    windowsHide: true,
    detached: _internals.platform() !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** One `kimi -p` attempt: spawn, collect stdout/stderr, honor the abort signal. */
function runKimiCliOnce(cliPath: string, args: string[], attemptSignal: AbortSignal): Promise<KimiCliRunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnKimiCli(cliPath, args, _internals.buildChildEnv());
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputCapped = false;
    let settled = false;

    // Capped collection: after MAX_COLLECTED_OUTPUT_BYTES the chunk is
    // truncated (byte slice — a split multibyte char at the boundary degrades
    // to U+FFFD, harmless for a truncated stream) and later chunks dropped.
    // The handler stays attached so the child never blocks on a full pipe.
    const collect = (current: string, bytesUsed: number, chunk: Buffer | string): { text: string; bytes: number } => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_COLLECTED_OUTPUT_BYTES - bytesUsed;
      if (remaining <= 0) {
        outputCapped = true;
        return { text: current, bytes: bytesUsed };
      }
      if (buf.length > remaining) outputCapped = true;
      const taken = buf.subarray(0, Math.min(buf.length, remaining));
      return { text: current + taken.toString(), bytes: bytesUsed + taken.length };
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      reject(new Error(`kimi CLI attempt aborted (timeout or shutdown)`));
    };

    if (attemptSignal.aborted) {
      onAbort();
      return;
    }
    attemptSignal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const next = collect(stdout, stdoutBytes, chunk);
      stdout = next.text;
      stdoutBytes = next.bytes;
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const next = collect(stderr, stderrBytes, chunk);
      stderr = next.text;
      stderrBytes = next.bytes;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      attemptSignal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      attemptSignal.removeEventListener('abort', onAbort);
      if (outputCapped) {
        stderr += '\n[kimi-mem] CLI output collection capped at 10MB (truncated)';
      }
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

export class KimiProvider extends OpenAICompatibleProvider<KimiConfig> {
  protected readonly providerName = 'Kimi';
  protected readonly syntheticIdPrefix = 'kimi';
  // Like Gemini: an empty CLI response skips processAgentResponse and leaves
  // the queue intact, rather than feeding '' into the parser/recovery path.
  protected readonly forwardEmptyMessageResponse = false;

  /** Stashed by getConfig() so missingApiKeyError() can surface the detail. */
  private cliResolutionError: Error | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): KimiConfig {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());

    let cliPath = '';
    this.cliResolutionError = null;
    try {
      cliPath = _internals.findKimiCli('SDK');
      clearDependencyStatus('kimi_cli');
    } catch (error) {
      this.cliResolutionError = error instanceof Error ? error : new Error(String(error));
    }

    // Resolve $TIER aliases first; the claude-ish → no-override mapping
    // happens per-query (resolveKimiModelArg) so summary-tier swaps in the
    // base class flow through the same mapping.
    const model = resolveTierAlias(settings.KIMI_MEM_MODEL, settings);

    return { apiKey: cliPath, cliPath, model };
  }

  protected prepareSessionExtras(session: ActiveSession, config: KimiConfig): void {
    // Tier routing (SessionRoutes.applyTierRouting) may set modelOverride to
    // the factory claude aliases — resolveKimiModelArg in query() maps those
    // to "no -m", i.e. the CLI's own default_model.
    if (session.modelOverride) {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      config.model = resolveTierAlias(session.modelOverride, settings);
    }
  }

  protected missingApiKeyError(): Error {
    const detail = this.cliResolutionError?.message ?? 'kimi CLI not found';
    recordKimiCliSetupRequired(detail);
    return new ClassifiedProviderError(detail, { kind: 'setup_required', cause: this.cliResolutionError });
  }

  protected estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  protected buildLastUsage(_result: ProviderQueryResult): ActiveSession['lastUsage'] {
    // The CLI reports no token usage on stream-json — never estimate one side.
    return null;
  }

  protected async query(history: ConversationMessage[], config: KimiConfig): Promise<ProviderQueryResult> {
    const budget = _internals.flattenedPromptBudget();
    const prompt = flattenHistoryForPrompt(history, budget.maxSize, budget.unit);
    const modelArg = resolveKimiModelArg(config.model);

    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (modelArg) {
      args.push('-m', modelArg);
    }

    logger.debug('SDK', `Querying kimi CLI (${modelArg ?? 'default_model'})`, {
      turns: history.length,
      promptChars: prompt.length,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      estimatedTokens: this.estimateTokens(prompt),
    });

    const result = await withRetry<KimiCliRunResult>(async (attemptSignal) => {
      let run: KimiCliRunResult;
      try {
        run = await runKimiCliOnce(config.cliPath, args, attemptSignal);
      } catch (spawnError: unknown) {
        // Spawn-level failure (ENOENT, abort/timeout) — classify directly.
        throw classifyKimiError({ cause: spawnError });
      }

      if (run.exitCode !== 0) {
        throw classifyKimiError({
          exitCode: run.exitCode,
          signal: run.signal,
          stderr: run.stderr,
          cause: new Error(`kimi CLI exited with code ${run.exitCode ?? 'unknown'} (${run.signal ?? 'no signal'})`),
        });
      }

      return run;
    }, {
      label: `kimi ${modelArg ?? 'default_model'}`,
      perAttemptTimeoutMs: _internals.perAttemptTimeoutMs,
    });

    const parsed = parseStreamJsonStdout(result.stdout);
    if (!parsed.content) {
      logger.error('SDK', 'Empty response from kimi CLI', {
        stdoutChars: result.stdout.length,
        stderrTail: result.stderr.trim().split('\n').slice(-3).join(' | ').substring(0, 300),
      });
      return { content: '' };
    }

    if (parsed.sessionId) {
      logger.debug('SDK', `kimi CLI session ${parsed.sessionId} completed (stateless call, not resumed)`);
    }

    return {
      content: parsed.content,
      // The CLI reports no usage; the effective model is the -m alias or the
      // CLI's own default_model (its concrete name is not printed).
      servedModel: modelArg ?? 'kimi default_model',
    };
  }
}

export function isKimiSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.KIMI_MEM_PROVIDER === 'kimi';
}

export function isKimiAvailable(): boolean {
  try {
    findKimiExecutable('SDK');
    return true;
  } catch {
    return false;
  }
}
