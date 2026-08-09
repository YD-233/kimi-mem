import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';

import {
  recordWorkerUnreachable,
  setActivePlatform,
} from '../../src/shared/worker-utils.js';
import { hookCommand } from '../../src/cli/hook-command.js';
import { HOOK_EXIT_CODES } from '../../src/shared/hook-constants.js';
import { DATA_DIR } from '../../src/shared/paths.js';

/**
 * Kimi Code must NEVER see a hook exit 2: on UserPromptSubmit it blocks the
 * model call, on PreToolUse it blocks the tool, on Stop it forces
 * continuation. The Claude Code fail-loud paths (worker-unreachable threshold
 * in worker-utils.recordWorkerUnreachable, generic hook errors in
 * hookCommand) therefore downgrade to a stderr diagnostic + exit 0 when the
 * active platform is kimi. These tests pin both the downgrade and the
 * unchanged claude-code behavior.
 */

const stateDir = join(DATA_DIR, 'state');
const failuresPath = join(stateDir, 'hook-failures.json');

/** Seed the fail-loud counter so the NEXT recordWorkerUnreachable trips the threshold. */
function seedFailuresBelowThreshold(): void {
  mkdirSync(stateDir, { recursive: true });
  // Default threshold is 3 (KIMI_MEM_HOOK_FAIL_LOUD_THRESHOLD unset in the
  // test data dir), so 2 means the next failure is the tripping one.
  writeFileSync(failuresPath, JSON.stringify({ consecutiveFailures: 2, lastFailureAt: Date.now() }), 'utf-8');
}

function captureRealStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  return { chunks, restore: () => { process.stderr.write = original as typeof process.stderr.write; } };
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

/** Intercept process.exit so the blocking path can be asserted without dying. */
function stubExit(): { codes: Array<number | string | null | undefined>; restore: () => void } {
  const codes: Array<number | string | null | undefined> = [];
  const original = process.exit;
  process.exit = ((code?: number | string | null) => {
    codes.push(code ?? 0);
    throw new Error(`__process_exit_${code}__`);
  }) as typeof process.exit;
  return { codes, restore: () => { process.exit = original; } };
}

const realStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
const realStdin = process.stdin;

function installFakeStdin(payload: string): void {
  const fake = Readable.from([payload], { objectMode: false }) as unknown as NodeJS.ReadStream;
  Object.defineProperty(fake, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: realStdinDescriptor?.enumerable ?? true,
    writable: true,
    value: fake,
  });
}

function restoreStdin(): void {
  if (realStdinDescriptor) {
    Object.defineProperty(process, 'stdin', realStdinDescriptor);
  } else {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true });
  }
}

let prevTelemetryEnv: string | undefined;

beforeEach(() => {
  rmSync(failuresPath, { force: true });
  // Keep the threshold-tripped hook_failed telemetry off the network; the
  // consent chain itself is covered elsewhere.
  prevTelemetryEnv = process.env.KIMI_MEM_TELEMETRY;
  process.env.KIMI_MEM_TELEMETRY = '0';
});

afterEach(() => {
  rmSync(failuresPath, { force: true });
  if (prevTelemetryEnv === undefined) delete process.env.KIMI_MEM_TELEMETRY;
  else process.env.KIMI_MEM_TELEMETRY = prevTelemetryEnv;
  restoreStdin();
});

describe('recordWorkerUnreachable platform gating', () => {
  it('kimi: dead worker past the threshold emits a diagnostic and never exits 2', async () => {
    setActivePlatform('kimi');
    seedFailuresBelowThreshold();
    const stderr = captureRealStderr();
    const stdout = captureStdout();
    const exit = stubExit();
    try {
      const count = await recordWorkerUnreachable();
      expect(count).toBe(3);
      expect(exit.codes).toHaveLength(0); // no process.exit at all
      expect(stderr.chunks.join('')).toContain('worker unreachable for 3 consecutive hooks');
      expect(stdout.lines).toEqual([]); // stdout stays silent for the model
    } finally {
      exit.restore();
      stdout.restore();
      stderr.restore();
    }
  });

  it('claude-code: unchanged — the tripping failure still exits 2 with the message on stderr', async () => {
    setActivePlatform('claude-code');
    seedFailuresBelowThreshold();
    const stderr = captureRealStderr();
    const exit = stubExit();
    try {
      await expect(recordWorkerUnreachable()).rejects.toThrow('__process_exit_2__');
      expect(exit.codes).toEqual([2]);
      expect(stderr.chunks.join('')).toContain('worker unreachable for 3 consecutive hooks.');
    } finally {
      exit.restore();
      stderr.restore();
    }
  });

  it('claude-code: below the threshold nothing surfaces and nothing exits', async () => {
    setActivePlatform('claude-code');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(failuresPath, JSON.stringify({ consecutiveFailures: 0, lastFailureAt: Date.now() }), 'utf-8');
    const stderr = captureRealStderr();
    const exit = stubExit();
    try {
      const count = await recordWorkerUnreachable();
      expect(count).toBe(1);
      expect(exit.codes).toHaveLength(0);
      expect(stderr.chunks.join('')).toBe('');
    } finally {
      exit.restore();
      stderr.restore();
    }
  });
});

describe('hookCommand generic-error path platform gating', () => {
  it('kimi: a generic hook error exits 0 with a diagnostic and silent stdout', async () => {
    installFakeStdin('this is not json'); // readJsonFromStdin rejects → generic error branch
    const stderr = captureRealStderr();
    const stdout = captureStdout();
    try {
      const code = await hookCommand('kimi', 'context', { skipExit: true });
      expect(code).toBe(HOOK_EXIT_CODES.SUCCESS);
      expect(stderr.chunks.join('')).toContain('non-blocking on kimi');
      expect(stdout.lines).toEqual([]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
  });

  it('claude-code: unchanged — a generic hook error stays a blocking error', async () => {
    installFakeStdin('this is not json');
    const stderr = captureRealStderr();
    const stdout = captureStdout();
    try {
      const code = await hookCommand('claude-code', 'context', { skipExit: true });
      expect(code).toBe(HOOK_EXIT_CODES.BLOCKING_ERROR);
      expect(stderr.chunks.join('')).toContain('Hook error:');
    } finally {
      stdout.restore();
      stderr.restore();
    }
  });

  it('hookCommand registers the platform alongside the hook type (source contract)', () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'hook-command.ts'), 'utf-8');
    expect(src).toContain('setActivePlatform(platform)');
  });
});
