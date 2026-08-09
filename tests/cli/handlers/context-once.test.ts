import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { contextOnceHandler, sweepStaleMarkers } from '../../../src/cli/handlers/context-once.js';
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

describe('sweepStaleMarkers', () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const sweepDir = join(DATA_DIR, 'state-sweep-test');
  const staleMarker = join(sweepDir, 'kimi-context-stale-session');
  const freshMarker = join(sweepDir, 'kimi-context-fresh-session');
  const unrelatedFile = join(sweepDir, 'hook-failures.json');

  beforeEach(() => {
    mkdirSync(sweepDir, { recursive: true });
    writeFileSync(staleMarker, '');
    writeFileSync(freshMarker, '');
    writeFileSync(unrelatedFile, '{}');
    // Backdate the stale marker beyond the 7-day horizon.
    const stale = new Date(Date.now() - SEVEN_DAYS_MS - 60_000);
    utimesSync(staleMarker, stale, stale);
  });

  afterEach(() => {
    rmSync(sweepDir, { recursive: true, force: true });
  });

  it('removes kimi-context markers older than 7 days, keeps fresh ones and other files', () => {
    sweepStaleMarkers(sweepDir);
    expect(existsSync(staleMarker)).toBe(false);
    expect(existsSync(freshMarker)).toBe(true);
    expect(existsSync(unrelatedFile)).toBe(true);
  });

  it('is a no-op for a missing directory', () => {
    expect(() => sweepStaleMarkers(join(sweepDir, 'does-not-exist'))).not.toThrow();
  });
});
