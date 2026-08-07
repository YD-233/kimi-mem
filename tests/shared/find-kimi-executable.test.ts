import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import {
  findKimiExecutable,
  resetKimiExecutableCache,
  _internals,
} from '../../src/shared/find-kimi-executable.js';

/**
 * All discovery/probing goes through the _internals seam, so these tests swap
 * its members instead of module-mocking child_process (mirrors
 * find-claude-executable.test.ts).
 */

const ORIGINALS = { ..._internals };

/** Paths that "exist" and the --version output each fake CLI prints. */
let fakeClis: Map<string, string>;
let whichOutput: string | null;
let whereOutputs: Record<string, string>;

function installFakes(options: { settingsPath?: string; platform?: NodeJS.Platform } = {}): void {
  _internals.platform = () => options.platform ?? 'linux';
  _internals.homedir = () => '/home/tester';
  _internals.loadSettings = () => ({ KIMI_CLI_PATH: options.settingsPath ?? '' }) as ReturnType<typeof ORIGINALS.loadSettings>;
  _internals.existsSync = (path) => fakeClis.has(String(path));

  _internals.execSync = ((command: string) => {
    if (command in whereOutputs) return whereOutputs[command];
    if (command === 'which -a kimi' && whichOutput !== null) return whichOutput;
    throw new Error(`not found: ${command}`);
  }) as typeof ORIGINALS.execSync;

  _internals.execFileSync = ((path: string) => {
    if (!fakeClis.has(path)) {
      const error = new Error(`spawn ${path} ENOENT`) as Error & { stderr: string };
      error.stderr = '';
      throw error;
    }
    return fakeClis.get(path)!;
  }) as typeof ORIGINALS.execFileSync;
}

beforeEach(() => {
  resetKimiExecutableCache();
  fakeClis = new Map();
  whichOutput = null;
  whereOutputs = {};
});

afterEach(() => {
  Object.assign(_internals, ORIGINALS);
  resetKimiExecutableCache();
});

describe('findKimiExecutable', () => {
  it('returns the configured KIMI_CLI_PATH when it probes OK', () => {
    fakeClis.set('/opt/kimi', '0.34.0');
    installFakes({ settingsPath: '/opt/kimi' });
    expect(findKimiExecutable()).toBe('/opt/kimi');
  });

  it('fails loud when KIMI_CLI_PATH does not exist', () => {
    installFakes({ settingsPath: '/nope/kimi' });
    expect(() => findKimiExecutable()).toThrow('KIMI_CLI_PATH is set to "/nope/kimi" but the file does not exist');
  });

  it('fails loud when KIMI_CLI_PATH cannot run --version', () => {
    installFakes({ settingsPath: '/broken/kimi' });
    fakeClis.set('/broken/kimi', ''); // exists, but --version prints nothing → broken
    expect(() => findKimiExecutable()).toThrow('failed the --version check');
  });

  it('discovers via which -a and prefers the newest version', () => {
    fakeClis.set('/usr/bin/kimi', '0.30.0');
    fakeClis.set('/usr/local/bin/kimi', '0.34.0');
    whichOutput = '/usr/bin/kimi\n/usr/local/bin/kimi';
    installFakes();
    expect(findKimiExecutable()).toBe('/usr/local/bin/kimi');
  });

  it('falls back to the native installer location under ~/.kimi-code/bin', () => {
    // join() matches the resolver's own path construction (backslashes on a
    // win32 host even when faking a posix platform).
    const nativePath = join('/home/tester', '.kimi-code', 'bin', 'kimi');
    fakeClis.set(nativePath, '0.34.0');
    installFakes();
    expect(findKimiExecutable()).toBe(nativePath);
  });

  it('throws a setup-required-style message when nothing is found', () => {
    installFakes();
    expect(() => findKimiExecutable()).toThrow('Kimi executable not found');
  });

  it('on Windows probes .exe candidates from where', () => {
    fakeClis.set('C:\\Users\\tester\\.kimi-code\\bin\\kimi.exe', '0.34.0');
    whereOutputs = { 'where kimi.exe': 'C:\\Users\\tester\\.kimi-code\\bin\\kimi.exe' };
    installFakes({ platform: 'win32' });
    expect(findKimiExecutable()).toBe('C:\\Users\\tester\\.kimi-code\\bin\\kimi.exe');
  });
});
