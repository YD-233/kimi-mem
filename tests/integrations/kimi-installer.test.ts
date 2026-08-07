import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { paths } from '../../src/shared/paths.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import {
  installKimiIntegration,
  uninstallKimiIntegration,
  checkKimiIntegrationStatus,
} from '../../src/services/integrations/KimiInstaller.js';

/**
 * Minimal fake plugin root so installs copy a few bytes instead of the real
 * plugin/ tree. getPluginRootAbsolutePath prefers CLAUDE_PLUGIN_ROOT, and the
 * installer requires kimi.plugin.json + scripts/ to accept the candidate.
 */
function createFakePluginRoot(root: string): void {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'kimi.plugin.json'), JSON.stringify({ name: 'kimi-mem', version: '0.0.0-test' }));
  writeFileSync(join(root, 'scripts', 'worker-service.cjs'), '// fake worker bundle\n');
  writeFileSync(join(root, 'commands', 'model.md'), '---\nname: model\n---\nfake\n');
}

function readInstalledJson(kimiHome: string): any {
  return JSON.parse(readFileSync(join(kimiHome, 'plugins', 'installed.json'), 'utf-8'));
}

describe('KimiInstaller (plugin-based)', () => {
  let tempDir: string;
  let kimiHome: string;
  let fakePluginRoot: string;
  let managedRoot: string;
  let spies: Array<{ mockRestore: () => void }> = [];

  const settingsPath = paths.settings();
  const settingsExistedBefore = existsSync(settingsPath);
  const originalSettings = settingsExistedBefore ? readFileSync(settingsPath, 'utf-8') : null;
  const originalKimiCodeHome = process.env.KIMI_CODE_HOME;
  const originalClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const originalPluginRoot = process.env.PLUGIN_ROOT;

  beforeEach(() => {
    tempDir = join(tmpdir(), `kimi-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    kimiHome = join(tempDir, 'kimi-code-home');
    fakePluginRoot = join(tempDir, 'fake-plugin');
    managedRoot = join(kimiHome, 'plugins', 'managed', 'kimi-mem');
    createFakePluginRoot(fakePluginRoot);

    process.env.KIMI_CODE_HOME = kimiHome;
    process.env.CLAUDE_PLUGIN_ROOT = fakePluginRoot;
    delete process.env.PLUGIN_ROOT;

    // Fresh settings file per test (loadFromFile materializes defaults).
    rmSync(settingsPath, { force: true });

    spies = [
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'warn').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];

    if (originalKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = originalKimiCodeHome;
    if (originalClaudePluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = originalClaudePluginRoot;
    if (originalPluginRoot === undefined) delete process.env.PLUGIN_ROOT;
    else process.env.PLUGIN_ROOT = originalPluginRoot;

    if (originalSettings === null) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, originalSettings);

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('install', () => {
    it('copies the plugin into the managed dir and registers the installed.json record', async () => {
      const result = await installKimiIntegration();
      expect(result).toBe(0);

      expect(existsSync(join(managedRoot, 'kimi.plugin.json'))).toBe(true);
      expect(existsSync(join(managedRoot, 'scripts', 'worker-service.cjs'))).toBe(true);
      expect(existsSync(join(managedRoot, 'commands', 'model.md'))).toBe(true);

      const installed = readInstalledJson(kimiHome);
      expect(installed.version).toBe(1);
      expect(installed.plugins).toHaveLength(1);

      const record = installed.plugins[0];
      expect(record.id).toBe('kimi-mem');
      expect(record.root).toBe(managedRoot);
      expect(record.source).toBe('local-path');
      expect(record.enabled).toBe(true);
      expect(record.originalSource).toBe('kimi-mem install');
      expect(Number.isNaN(Date.parse(record.installedAt))).toBe(false);
      expect(Number.isNaN(Date.parse(record.updatedAt))).toBe(false);
    });

    it('never writes config.toml hooks or an mcp.json entry', async () => {
      const result = await installKimiIntegration();
      expect(result).toBe(0);

      expect(existsSync(join(kimiHome, 'config.toml'))).toBe(false);
      expect(existsSync(join(kimiHome, 'mcp.json'))).toBe(false);
    });

    it('writes provider=kimi to a fresh settings.json without forcing openrouter keys', async () => {
      const result = await installKimiIntegration();
      expect(result).toBe(0);

      const defaults = SettingsDefaultsManager.getAllDefaults();
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.KIMI_MEM_PROVIDER).toBe('kimi');
      // The independent-API fallback stays at factory defaults — the
      // installer no longer pins Moonshot base URL/model/tier values.
      expect(settings.KIMI_MEM_OPENROUTER_API_KEY ?? '').toBe('');
      expect(settings.KIMI_MEM_OPENROUTER_BASE_URL).toBe(defaults.KIMI_MEM_OPENROUTER_BASE_URL);
      expect(settings.KIMI_MEM_OPENROUTER_MODEL).toBe(defaults.KIMI_MEM_OPENROUTER_MODEL);
      expect(settings.KIMI_MEM_TIER_SIMPLE_MODEL).toBe(defaults.KIMI_MEM_TIER_SIMPLE_MODEL);
      expect(settings.KIMI_MEM_TIER_SUMMARY_MODEL).toBe(defaults.KIMI_MEM_TIER_SUMMARY_MODEL);
    });

    it('leaves settings untouched when an API key is already configured', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        KIMI_MEM_PROVIDER: 'openrouter',
        KIMI_MEM_OPENROUTER_API_KEY: 'sk-test-existing',
        KIMI_MEM_OPENROUTER_MODEL: 'custom-model',
        KIMI_MEM_TIER_SIMPLE_MODEL: 'custom-tier',
      }));

      const result = await installKimiIntegration();
      expect(result).toBe(0);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.KIMI_MEM_PROVIDER).toBe('openrouter');
      expect(settings.KIMI_MEM_OPENROUTER_MODEL).toBe('custom-model');
      expect(settings.KIMI_MEM_TIER_SIMPLE_MODEL).toBe('custom-tier');
    });

    it('keeps customized openrouter model/tier values when writing provider=kimi', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        KIMI_MEM_OPENROUTER_MODEL: 'custom-model',
        KIMI_MEM_TIER_SIMPLE_MODEL: 'custom-tier',
      }));

      const result = await installKimiIntegration();
      expect(result).toBe(0);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.KIMI_MEM_PROVIDER).toBe('kimi');
      expect(settings.KIMI_MEM_OPENROUTER_MODEL).toBe('custom-model');
      expect(settings.KIMI_MEM_TIER_SIMPLE_MODEL).toBe('custom-tier');
    });

    it('preserves other plugin records and keeps installedAt on re-install', async () => {
      mkdirSync(join(kimiHome, 'plugins'), { recursive: true });
      const fakeRecord = {
        id: 'other-plugin',
        root: join(kimiHome, 'plugins', 'managed', 'other-plugin'),
        source: 'local-path',
        enabled: true,
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        originalSource: '/somewhere/else',
      };
      writeFileSync(
        join(kimiHome, 'plugins', 'installed.json'),
        JSON.stringify({ version: 1, plugins: [fakeRecord] }),
      );

      expect(await installKimiIntegration()).toBe(0);
      const first = readInstalledJson(kimiHome);
      expect(first.plugins).toHaveLength(2);
      expect(first.plugins.find((p: any) => p.id === 'other-plugin')).toEqual(fakeRecord);
      const firstRecord = first.plugins.find((p: any) => p.id === 'kimi-mem');

      expect(await installKimiIntegration()).toBe(0);
      const second = readInstalledJson(kimiHome);
      expect(second.plugins).toHaveLength(2);
      const secondRecord = second.plugins.find((p: any) => p.id === 'kimi-mem');
      expect(secondRecord.installedAt).toBe(firstRecord.installedAt);
    });
  });

  describe('uninstall', () => {
    it('removes the record and managed copy, preserving other plugins and user files', async () => {
      mkdirSync(join(kimiHome, 'plugins'), { recursive: true });
      const fakeRecord = {
        id: 'other-plugin',
        root: join(kimiHome, 'plugins', 'managed', 'other-plugin'),
        source: 'local-path',
        enabled: true,
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        originalSource: '/somewhere/else',
      };
      writeFileSync(
        join(kimiHome, 'plugins', 'installed.json'),
        JSON.stringify({ version: 1, plugins: [fakeRecord] }),
      );
      writeFileSync(join(kimiHome, 'config.toml'), '# user config\nmodel = "kimi-k2.6"\n');
      writeFileSync(join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: { userServer: { command: 'x' } } }));

      expect(await installKimiIntegration()).toBe(0);
      expect(existsSync(managedRoot)).toBe(true);

      expect(uninstallKimiIntegration()).toBe(0);

      const installed = readInstalledJson(kimiHome);
      expect(installed.plugins).toEqual([fakeRecord]);
      expect(existsSync(managedRoot)).toBe(false);

      // Pre-existing user files the new installer does not own survive.
      expect(readFileSync(join(kimiHome, 'config.toml'), 'utf-8')).toBe('# user config\nmodel = "kimi-k2.6"\n');
      expect(JSON.parse(readFileSync(join(kimiHome, 'mcp.json'), 'utf-8')).mcpServers.userServer.command).toBe('x');
    });

    it('is a no-op when nothing is installed', () => {
      expect(uninstallKimiIntegration()).toBe(0);
      expect(existsSync(join(kimiHome, 'plugins', 'installed.json'))).toBe(false);
    });
  });

  describe('status', () => {
    it('exits 0 when installed and when not installed', async () => {
      expect(await checkKimiIntegrationStatus()).toBe(0);
      expect(await installKimiIntegration()).toBe(0);
      expect(await checkKimiIntegrationStatus()).toBe(0);
    });
  });
});
