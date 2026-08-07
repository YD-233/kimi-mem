// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { contextHandler } from './context.js';
import { DATA_DIR } from '../../shared/paths.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';

/**
 * context-once: the `context` handler gated to one injection per session.
 *
 * Kimi Code only appends hook stdout to the model context on UserPromptSubmit
 * (SessionStart hook output is discarded — verified against agent-core-v2's
 * SessionExternalHooksService, which fire-and-forgets SessionStart results).
 * Binding the plain `context` handler to UserPromptSubmit would re-inject the
 * full session summary on every prompt, so kimi binds this wrapper instead:
 * the first prompt of a session injects context and leaves a marker file;
 * later prompts no-op. When the worker is unreachable the context handler
 * returns an empty additionalContext and no marker is written, so the next
 * prompt retries the injection.
 *
 * Markers live at <DATA_DIR>/state/kimi-context-<sessionId>. They are empty
 * files; the session id in the filename is sanitized so a hostile stdin
 * session_id cannot escape the state dir.
 */
const SAFE_MARKER_KEY_RE = /^[A-Za-z0-9_-]+$/;

function markerPathFor(sessionId: string): string {
  const key = SAFE_MARKER_KEY_RE.test(sessionId)
    ? sessionId
    : createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return join(DATA_DIR, 'state', `kimi-context-${key}`);
}

function noOpResult(): HookResult {
  return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
}

export const contextOnceHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const sessionId = input.sessionId;

    // Without a session id there is no stable marker key; fall back to the
    // ungated context handler rather than dropping context entirely.
    if (!sessionId) {
      logger.warn('HOOK', 'context-once: No sessionId provided, delegating without once-per-session gating');
      return contextHandler.execute(input);
    }

    const markerPath = markerPathFor(sessionId);
    if (existsSync(markerPath)) {
      return noOpResult();
    }

    const result = await contextHandler.execute(input);

    // Gate on a successful injection, not on the attempt: an unreachable
    // worker yields an empty additionalContext, and the marker is only written
    // when something was actually injected so the next prompt can retry.
    const injected = result.hookSpecificOutput?.additionalContext;
    if (typeof injected === 'string' && injected.trim().length > 0) {
      try {
        mkdirSync(join(DATA_DIR, 'state'), { recursive: true });
        // 'wx' keeps the check-and-create atomic against a duplicated hook
        // entry racing the same session; EEXIST simply means we lost the race.
        writeFileSync(markerPath, '', { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          logger.warn('HOOK', `context-once: failed to write marker ${markerPath}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    return result;
  }
};
