import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { EventEmitter } from 'events';

import {
  KimiProvider,
  resolveKimiModelArg,
  flattenHistoryForPrompt,
  parseStreamJsonStdout,
  classifyKimiError,
  _internals,
} from '../../src/services/worker/KimiProvider.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import {
  getDependencyStatus,
  resetDependencyStatusesForTesting,
} from '../../src/shared/dependency-health.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

/**
 * All process interaction goes through the _internals seam, so tests swap its
 * members instead of module-mocking child_process (mock.module is
 * process-global and sticky in bun — see tests/preload.ts notes).
 */

const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'obs prompt',
    summary: 'summary prompt',
  },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killCalls: string[] = [];

  kill(signal?: string): boolean {
    this.killCalls.push(signal ?? 'SIGTERM');
    return true;
  }

  respond(stdout: string, exitCode = 0, stderr = ''): void {
    if (stdout) this.stdout.emit('data', Buffer.from(stdout));
    if (stderr) this.stderr.emit('data', Buffer.from(stderr));
    this.emit('close', exitCode, null);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { env?: Record<string, string> };
  child: FakeChildProcess;
}

const ORIGINALS = { ..._internals };

let spawnCalls: SpawnCall[];
let loadFromFileSpy: ReturnType<typeof spyOn> | null;
let modeManagerSpy: ReturnType<typeof spyOn> | null;

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'test-session',
    memorySessionId: 'mem-session-123',
    project: 'test-project',
    platformSource: 'kimi',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  } as ActiveSession;
}

function mockSettings(overrides: Record<string, string> = {}): void {
  loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(),
    ...overrides,
  }));
}

/** Expose the protected query() for transport-level assertions. */
class TestKimiProvider extends KimiProvider {
  callQuery(history: ConversationMessage[], config: { apiKey: string; model: string; cliPath: string }) {
    return this.query(history, config);
  }
}

function makeProvider(messages: Array<Record<string, unknown>> = []): KimiProvider {
  return new TestKimiProvider({} as any, {
    getMessageIterator: async function* () {
      for (const message of messages) yield message;
    },
  } as any);
}

beforeEach(() => {
  spawnCalls = [];
  loadFromFileSpy = null;
  modeManagerSpy = null;
  resetDependencyStatusesForTesting();

  _internals.spawnProcess = ((command: string, args: string[], options: any) => {
    const child = new FakeChildProcess();
    spawnCalls.push({ command, args, options, child });
    return child;
  }) as any;
  _internals.findKimiCli = () => '/fake/kimi';
  _internals.platform = () => 'linux';
});

afterEach(() => {
  Object.assign(_internals, ORIGINALS);
  loadFromFileSpy?.mockRestore();
  modeManagerSpy?.mockRestore();
});

describe('resolveKimiModelArg', () => {
  it('maps claude-ish values to "no override"', () => {
    expect(resolveKimiModelArg('haiku')).toBeNull();
    expect(resolveKimiModelArg('sonnet')).toBeNull();
    expect(resolveKimiModelArg('opus')).toBeNull();
    expect(resolveKimiModelArg('claude-haiku-4-5-20251001')).toBeNull();
    expect(resolveKimiModelArg('claude-sonnet-4-6')).toBeNull();
    expect(resolveKimiModelArg('')).toBeNull();
    expect(resolveKimiModelArg(null)).toBeNull();
    expect(resolveKimiModelArg(undefined)).toBeNull();
    expect(resolveKimiModelArg('  ')).toBeNull();
  });

  it('passes other aliases through verbatim', () => {
    expect(resolveKimiModelArg('kimi-code/kimi-for-coding')).toBe('kimi-code/kimi-for-coding');
    expect(resolveKimiModelArg('kimi-k2.6')).toBe('kimi-k2.6');
  });
});

describe('flattenHistoryForPrompt', () => {
  const history: ConversationMessage[] = [
    { role: 'user', content: 'init instructions' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'observation one' },
  ];

  it('labels roles and joins turns', () => {
    const prompt = flattenHistoryForPrompt(history, 100_000);
    expect(prompt).toBe('User:\ninit instructions\n\nAssistant:\nfirst reply\n\nUser:\nobservation one');
  });

  it('returns the full history when it fits the budget', () => {
    expect(flattenHistoryForPrompt(history, 100_000)).toContain('init instructions');
  });

  it('elides oldest turns over budget and keeps the newest whole', () => {
    const big: ConversationMessage[] = [
      { role: 'user', content: 'I'.repeat(100) },
      { role: 'assistant', content: 'A'.repeat(100) },
      { role: 'user', content: 'B'.repeat(100) },
      { role: 'user', content: 'NEWEST' },
    ];
    const prompt = flattenHistoryForPrompt(big, 150);
    expect(prompt).toContain('NEWEST');
    expect(prompt).toContain('elided');
    expect(prompt).not.toContain('I'.repeat(100));
  });

  it('never truncates the newest turn even when it alone exceeds the budget', () => {
    const big: ConversationMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'user', content: 'N'.repeat(500) },
    ];
    const prompt = flattenHistoryForPrompt(big, 50);
    expect(prompt).toContain('N'.repeat(500));
  });
});

describe('parseStreamJsonStdout', () => {
  it('concatenates assistant events and lifts the session id', () => {
    const stdout = [
      '{"role":"meta","type":"system.version","version":"0.34.0"}',
      '{"role":"assistant","content":"<observation>"}',
      '{"role":"assistant","content":"</observation>"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"session_abc","command":"kimi -r session_abc"}',
      '',
    ].join('\n');
    const parsed = parseStreamJsonStdout(stdout);
    expect(parsed.content).toBe('<observation>\n</observation>');
    expect(parsed.sessionId).toBe('session_abc');
  });

  it('ignores non-JSON lines', () => {
    const parsed = parseStreamJsonStdout('garbage\n{"role":"assistant","content":"ok"}');
    expect(parsed.content).toBe('ok');
    expect(parsed.sessionId).toBeUndefined();
  });

  it('returns empty content for empty stdout', () => {
    expect(parseStreamJsonStdout('').content).toBe('');
  });
});

describe('classifyKimiError', () => {
  it('maps missing executable to setup_required', () => {
    const err = classifyKimiError({ cause: new Error('spawn /nope/kimi ENOENT') });
    expect(err.kind).toBe('setup_required');
    expect(classifyKimiError({ cause: new Error('Kimi executable not found. Please either:') }).kind).toBe('setup_required');
    expect(classifyKimiError({ cause: new Error('KIMI_CLI_PATH is set to "x" but the file does not exist.') }).kind).toBe('setup_required');
  });

  it('maps auth wording to auth_invalid', () => {
    expect(classifyKimiError({ exitCode: 1, stderr: 'Error: 401 Unauthorized', cause: new Error('x') }).kind).toBe('auth_invalid');
  });

  it('maps quota/rate-limit/context wording', () => {
    expect(classifyKimiError({ exitCode: 1, stderr: 'quota exceeded for this plan', cause: new Error('x') }).kind).toBe('quota_exhausted');
    expect(classifyKimiError({ exitCode: 1, stderr: '429 too many requests', cause: new Error('x') }).kind).toBe('rate_limit');
    expect(classifyKimiError({ exitCode: 1, stderr: 'maximum context length exceeded', cause: new Error('x') }).kind).toBe('unrecoverable');
  });

  it('treats generic non-zero exits and signals as transient', () => {
    expect(classifyKimiError({ exitCode: 1, stderr: 'something odd', cause: new Error('x') }).kind).toBe('transient');
    expect(classifyKimiError({ exitCode: null, signal: 'SIGTERM', cause: new Error('x') }).kind).toBe('transient');
  });
});

describe('KimiProvider CLI transport', () => {
  const config = { apiKey: '/fake/kimi', model: 'haiku', cliPath: '/fake/kimi' };
  const history: ConversationMessage[] = [{ role: 'user', content: 'do something' }];

  it('spawns kimi with -p and stream-json, and no -m for claude-ish models', async () => {
    const provider = new TestKimiProvider({} as any, {} as any);
    const promise = provider.callQuery(history, config);
    const call = spawnCalls[0];
    call.child.respond('{"role":"assistant","content":"<observation/>"}\n');

    const result = await promise;
    expect(result.content).toBe('<observation/>');
    expect(call.command).toBe('/fake/kimi');
    expect(call.args[0]).toBe('-p');
    expect(call.args[1]).toBe('User:\ndo something');
    expect(call.args).toContain('--output-format');
    expect(call.args).toContain('stream-json');
    expect(call.args).not.toContain('-m');
  });

  it('passes -m for non-claude model aliases', async () => {
    const provider = new TestKimiProvider({} as any, {} as any);
    const promise = provider.callQuery(history, { ...config, model: 'kimi-code/kimi-for-coding' });
    const call = spawnCalls[0];
    call.child.respond('{"role":"assistant","content":"ok"}\n');

    const result = await promise;
    expect(result.content).toBe('ok');
    expect(result.servedModel).toBe('kimi-code/kimi-for-coding');
    const mIndex = call.args.indexOf('-m');
    expect(mIndex).toBeGreaterThan(-1);
    expect(call.args[mIndex + 1]).toBe('kimi-code/kimi-for-coding');
  });

  it('marks default-model responses as served by the CLI default', async () => {
    const provider = new TestKimiProvider({} as any, {} as any);
    const promise = provider.callQuery(history, config);
    spawnCalls[0].child.respond('{"role":"assistant","content":"ok"}\n');
    const result = await promise;
    expect(result.servedModel).toBe('kimi default_model');
  });

  it('spawns with KIMI_MEM_INTERNAL=1 in the child env (recursion guard)', async () => {
    const provider = new TestKimiProvider({} as any, {} as any);
    const promise = provider.callQuery(history, config);
    const call = spawnCalls[0];
    call.child.respond('{"role":"assistant","content":"ok"}\n');
    await promise;
    expect(call.options.env?.KIMI_MEM_INTERNAL).toBe('1');
  });

  it('spawns from the observer-sessions dir, not the worker cwd', async () => {
    const provider = new TestKimiProvider({} as any, {} as any);
    const promise = provider.callQuery(history, config);
    const call = spawnCalls[0];
    call.child.respond('{"role":"assistant","content":"ok"}\n');
    await promise;
    expect(String((call.options as { cwd?: string }).cwd ?? '')).toContain('observer-sessions');
  });

  it('wraps .cmd shims in cmd.exe on win32', async () => {
    _internals.platform = () => 'win32';
    const provider = new TestKimiProvider({} as any, {} as any);
    const promise = provider.callQuery(history, { ...config, cliPath: 'C:\\tools\\kimi.cmd' });
    const call = spawnCalls[0];
    call.child.respond('{"role":"assistant","content":"ok"}\n');
    await promise;
    expect(call.command).toBe(process.env.ComSpec ?? 'cmd.exe');
    expect(call.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(call.args[3]).toContain('kimi.cmd');
    expect(call.args[3]).toContain('--output-format');
  });

  it('classifies a non-zero exit via stderr wording (auth → no retry)', async () => {
    const provider = new TestKimiProvider({} as any, {} as any);
    const promise = provider.callQuery(history, config);
    spawnCalls[0].child.respond('', 1, 'Error: 401 Unauthorized');

    await expect(promise).rejects.toMatchObject({ kind: 'auth_invalid' });
    expect(spawnCalls).toHaveLength(1); // auth_invalid is not retryable
  });

  it('retries transient exits and then throws classified', async () => {
    const provider = new TestKimiProvider({} as any, {} as any);
    let settled = false;
    const done = provider.callQuery(history, config).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );

    // Drive each attempt as it spawns (initial + retries) until the query settles.
    let responded = 0;
    const deadline = Date.now() + 8_000;
    while (!settled && Date.now() < deadline) {
      const call = spawnCalls[responded];
      if (call) {
        responded += 1;
        call.child.respond('', 1, 'boom');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const error = await done;
    // Drain any in-flight attempt so no per-attempt timer dangles.
    for (let i = responded; i < spawnCalls.length; i++) {
      spawnCalls[i].child.respond('{"role":"assistant","content":"ok"}\n');
    }

    expect(responded).toBe(3); // initial attempt + 2 retries
    expect(error).toBeInstanceOf(ClassifiedProviderError);
    expect((error as ClassifiedProviderError).kind).toBe('transient');
  }, 10_000);

  it('kills the child when the attempt times out', async () => {
    _internals.perAttemptTimeoutMs = 50;
    const provider = new TestKimiProvider({} as any, {} as any);
    // Never respond; all attempts (initial + retries) time out.
    await expect(provider.callQuery(history, config)).rejects.toMatchObject({ kind: 'transient' });
    expect(spawnCalls[0].child.killCalls.length).toBeGreaterThan(0);
  }, 10_000);
});

describe('KimiProvider session flow', () => {
  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));
  });

  /**
   * Drives a full startSession: the init spawn happens synchronously, and
   * each queued message spawns once the previous response lands. Responding
   * with empty assistant content keeps processAgentResponse (and its DB
   * needs) out of the picture. Returns every spawn in order.
   */
  async function runSession(provider: KimiProvider, session: ActiveSession): Promise<SpawnCall[]> {
    const all: SpawnCall[] = [];
    const promise = provider.startSession(session);
    while (spawnCalls.length > 0) {
      const call = spawnCalls.shift()!;
      all.push(call);
      call.child.respond('{"role":"assistant","content":""}\n');
      // Microtasks flush before this macrotask, so the provider has either
      // finished or queued the next spawn by the time the loop re-checks.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await promise;
    return all;
  }

  const OBSERVATION = { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2 };
  const SUMMARIZE = { type: 'summarize', last_assistant_message: 'done' };

  it('omits -m for the factory claude-haiku default KIMI_MEM_MODEL', async () => {
    mockSettings({ KIMI_MEM_MODEL: 'claude-haiku-4-5-20251001' });
    const calls = await runSession(makeProvider([OBSERVATION, SUMMARIZE]), makeSession());
    expect(calls.length).toBe(3); // init + observation + summarize
    for (const call of calls) {
      expect(call.args).not.toContain('-m');
      expect(call.args[0]).toBe('-p');
      expect(call.args).toContain('stream-json');
    }
  });

  it('adds -m for a kimi model alias in KIMI_MEM_MODEL', async () => {
    mockSettings({ KIMI_MEM_MODEL: 'kimi-code/kimi-for-coding' });
    const calls = await runSession(makeProvider([OBSERVATION, SUMMARIZE]), makeSession());
    expect(calls.length).toBe(3);
    for (const call of calls) {
      const mIndex = call.args.indexOf('-m');
      expect(mIndex).toBeGreaterThan(-1);
      expect(call.args[mIndex + 1]).toBe('kimi-code/kimi-for-coding');
    }
  });

  it('treats a claude-ish tier modelOverride as "no override"', async () => {
    mockSettings({ KIMI_MEM_MODEL: 'kimi-code/kimi-for-coding' });
    const calls = await runSession(makeProvider(), makeSession({ modelOverride: 'haiku' }));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.args).not.toContain('-m');
  });

  it('passes a kimi alias modelOverride as -m even over the factory default', async () => {
    mockSettings({ KIMI_MEM_MODEL: 'claude-haiku-4-5-20251001' });
    const calls = await runSession(makeProvider(), makeSession({ modelOverride: 'kimi-code/kimi-for-coding' }));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const mIndex = call.args.indexOf('-m');
      expect(mIndex).toBeGreaterThan(-1);
      expect(call.args[mIndex + 1]).toBe('kimi-code/kimi-for-coding');
    }
  });

  it('throws setup_required and records dependency health when the CLI is missing', async () => {
    mockSettings();
    _internals.findKimiCli = () => {
      throw new Error('Kimi executable not found. Please either:\n1. ...');
    };

    const provider = makeProvider();
    let caught: unknown = null;
    try {
      await provider.startSession(makeSession());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClassifiedProviderError);
    expect((caught as ClassifiedProviderError).kind).toBe('setup_required');
    expect(getDependencyStatus('kimi_cli')?.kind).toBe('setup_required');
  });
});
