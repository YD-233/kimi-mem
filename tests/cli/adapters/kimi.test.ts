import { describe, it, expect } from 'bun:test';
import { kimiAdapter, encodeKimiWorkDirKey } from '../../../src/cli/adapters/kimi.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

describe('kimiAdapter.normalizeInput', () => {
  it('maps a UserPromptSubmit payload', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session_abc',
      session_title: 'Fix the login page',
      client_type: 'kimi_code_cli',
      cwd: '/tmp/project',
      prompt: 'hello world',
      is_steer: false,
    });

    expect(normalized.sessionId).toBe('session_abc');
    expect(normalized.cwd).toBe('/tmp/project');
    expect(normalized.prompt).toBe('hello world');
  });

  it('maps a PostToolUse payload, tool_output -> toolResponse', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'PostToolUse',
      session_id: 'session_abc',
      cwd: '/tmp/project',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/project/a.ts' },
      tool_call_id: 'call_1',
      tool_output: 'file contents',
    });

    expect(normalized.toolName).toBe('Read');
    expect(normalized.toolInput).toEqual({ file_path: '/tmp/project/a.ts' });
    expect(normalized.toolResponse).toBe('file contents');
  });

  it('maps Stop payload stop_hook_active', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'Stop',
      session_id: 'session_abc',
      cwd: '/tmp/project',
      stop_hook_active: true,
    });
    expect(normalized.stopHookActive).toBe(true);

    const notActive = kimiAdapter.normalizeInput({
      hook_event_name: 'Stop',
      session_id: 'session_abc',
      cwd: '/tmp/project',
      stop_hook_active: false,
    });
    expect(notActive.stopHookActive).toBeUndefined();
  });

  it('maps SessionStart source to sessionSource', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'SessionStart',
      session_id: 'session_abc',
      cwd: '/tmp/project',
      source: 'resume',
      model: 'kimi-k3',
    });
    expect(normalized.sessionSource).toBe('resume');
    expect(normalized.model).toBe('kimi-k3');
  });

  it('rejects an invalid cwd', () => {
    expect(() => kimiAdapter.normalizeInput({ session_id: 's', cwd: '' })).toThrow(AdapterRejectedInput);
  });
});

describe('kimiAdapter.formatOutput', () => {
  it('unwraps additionalContext into { message } for UserPromptSubmit injection', () => {
    const output = kimiAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '## past context' },
    });
    expect(output).toEqual({ message: '## past context' });
  });

  it('returns undefined for an empty additionalContext (prints nothing)', () => {
    expect(kimiAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
    })).toBeUndefined();
    expect(kimiAdapter.formatOutput({ continue: true, suppressOutput: true })).toBeUndefined();
  });
});

describe('encodeKimiWorkDirKey', () => {
  it('normalizes backslashes and trailing slashes before hashing', () => {
    // Mirrors kimi-code's encodeWorkDirKey: wd_<slug>_<sha256(normalized)[:12]>
    const a = encodeKimiWorkDirKey('C:\\Users\\foo\\My Project');
    const b = encodeKimiWorkDirKey('C:/Users/foo/My Project/');
    expect(a).toBe(b);
    expect(a.startsWith('wd_my-project_')).toBe(true);
    expect(a).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
  });

  it('falls back to "workspace" for an empty/dot slug', () => {
    expect(encodeKimiWorkDirKey('/..').startsWith('wd_workspace_')).toBe(true);
  });
});
