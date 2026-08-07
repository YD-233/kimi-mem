import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

/**
 * Kimi Code (MoonshotAI) platform adapter.
 *
 * Stdin payload shape (verified against MoonshotAI/kimi-code
 * packages/agent-core-v2 hook runner — all keys snake_cased by
 * `toHookInputData` in src/app/externalHooksRunner/runner.ts):
 *
 *   base:          hook_event_name, session_id, session_title, client_type, cwd
 *   UserPromptSubmit: + prompt, is_steer
 *   PreToolUse:       + tool_name, tool_input, tool_call_id
 *   PostToolUse:      + tool_name, tool_input, tool_call_id, tool_output (string, <=2000 chars)
 *   PostToolUseFailure: + tool_name, tool_input, tool_call_id, error
 *   Stop:             + stop_hook_active
 *   SessionStart:     + source, model, profile   (stdout NOT injected — observation-only)
 *   SessionEnd:       + reason
 *
 * Output contract: Kimi has no hookSpecificOutput.additionalContext channel.
 * On UserPromptSubmit, exit-0 stdout is appended to the model context wrapped
 * in <hook_result hook_event="UserPromptSubmit"> tags; when stdout parses as
 * JSON, the `message` field is used instead of the raw text (see
 * agent/externalHooks/runner.ts HookJsonOutputSchema and user-prompt.ts).
 * ANY non-empty stdout is injected, so the no-op output must print NOTHING —
 * formatOutput returns undefined and hook-io's emitModelContext skips the
 * stdout write for undefined/null.
 */

// Kimi session ids are UUID-style identifiers. Same path-traversal guard as
// the cursor adapter (security review on PR #2282): a malicious session_id
// from stdin must not escape the sessions dir via separators or '..'.
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const MAX_WORKDIR_SLUG_LENGTH = 40;

/**
 * Kimi's hook spawner merges process.env into the hook environment, so
 * KIMI_CODE_HOME is visible here when the user relocated their data dir.
 */
export function getKimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

/**
 * Replicates kimi-code's encodeWorkDirKey
 * (packages/agent-core-v2/src/_base/utils/workdir-slug.ts):
 * `wd_<slug>_<first 12 hex chars of sha256(normalized cwd)>` where the cwd is
 * normalized to forward slashes with trailing slashes stripped.
 */
export function encodeKimiWorkDirKey(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

/**
 * Derive the on-disk path to a Kimi session wire transcript:
 *
 *   $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl
 *
 * Returns undefined if the file does not exist. The wire.jsonl line schema is
 * undocumented; consumers (extractLastMessage) skip unparseable lines, so a
 * schema mismatch degrades to "no summary" rather than a hook failure.
 */
export function deriveKimiTranscriptPath(cwd: string | undefined, sessionId: string | undefined): string | undefined {
  if (!cwd || !sessionId) return undefined;
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return undefined;
  const candidate = join(
    getKimiCodeHome(),
    'sessions',
    encodeKimiWorkDirKey(cwd),
    sessionId,
    'agents',
    'main',
    'wire.jsonl',
  );
  return existsSync(candidate) ? candidate : undefined;
}

export const kimiAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const cwd = r.cwd ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    const sessionId = r.session_id ?? r.sessionId;
    const source = r.source;
    return {
      sessionId,
      cwd,
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      // PostToolUse carries `tool_output` (string); accept tool_response too
      // in case a future kimi version aligns with Claude Code's field name.
      toolResponse: r.tool_output ?? r.tool_response,
      transcriptPath: deriveKimiTranscriptPath(cwd, sessionId),
      stopHookActive: r.stop_hook_active === true ? true : undefined,
      model: typeof r.model === 'string' ? r.model : undefined,
      sessionSource: source === 'startup' || source === 'resume' || source === 'clear' ? source : undefined,
    };
  },
  formatOutput(result) {
    const additionalContext = result?.hookSpecificOutput?.additionalContext;
    if (typeof additionalContext === 'string' && additionalContext.trim().length > 0) {
      // Kimi unwraps the `message` field of a JSON stdout payload and appends
      // it to the model context (UserPromptSubmit).
      return { message: additionalContext };
    }
    // No-op: print nothing. Any non-empty stdout would be injected into the
    // model context verbatim, so even '{}' is noise. emitModelContext treats
    // undefined as "no model-bound payload".
    return undefined;
  }
};
