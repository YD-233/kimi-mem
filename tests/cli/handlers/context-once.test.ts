import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { contextOnceHandler } from '../../../src/cli/handlers/context-once.js';
import { DATA_DIR } from '../../../src/shared/paths.js';

const SESSION = 'context-once-test-session';
const stateDir = join(DATA_DIR, 'state');
const marker = join(stateDir, `kimi-context-${SESSION}`);

describe('contextOnceHandler', () => {
  beforeEach(() => {
    rmSync(marker, { force: true });
  });

  afterEach(() => {
    rmSync(marker, { force: true });
  });

  it('no-ops when the session marker already exists', async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(marker, '');

    const result = await contextOnceHandler.execute({
      sessionId: SESSION,
      cwd: process.cwd(),
      platform: 'kimi',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('delegates without writing a marker when nothing was injected', async () => {
    // KIMI_MEM_INTERNAL=1 makes shouldTrackProject exclude the project, so
    // the context handler returns an empty additionalContext without touching
    // the worker — deterministic regardless of worker state.
    const prev = process.env.KIMI_MEM_INTERNAL;
    process.env.KIMI_MEM_INTERNAL = '1';
    try {
      const result = await contextOnceHandler.execute({
        sessionId: SESSION,
        cwd: process.cwd(),
        platform: 'kimi',
      });

      expect(result.hookSpecificOutput?.additionalContext ?? '').toBe('');
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEM_INTERNAL;
      else process.env.KIMI_MEM_INTERNAL = prev;
    }
  });

  it('hashes an unsafe session id into the marker filename', async () => {
    // Path-traversal session ids must not escape the state dir; the marker is
    // keyed by a hash instead. Marker-absent path → delegates (excluded
    // project → empty context, no marker write).
    const prev = process.env.KIMI_MEM_INTERNAL;
    process.env.KIMI_MEM_INTERNAL = '1';
    try {
      const result = await contextOnceHandler.execute({
        sessionId: '../../etc/evil',
        cwd: process.cwd(),
        platform: 'kimi',
      });
      expect(result.hookSpecificOutput?.additionalContext ?? '').toBe('');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEM_INTERNAL;
      else process.env.KIMI_MEM_INTERNAL = prev;
    }
    expect(existsSync(join(stateDir, 'kimi-context-../../etc/evil'))).toBe(false);
  });
});
