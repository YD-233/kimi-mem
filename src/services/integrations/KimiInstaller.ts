/**
 * KimiInstaller.ts — plugin-based installer for Kimi Code (MoonshotAI).
 *
 * The Kimi Code plugin manifest (plugin/kimi.plugin.json) is the single
 * integration source: hooks, the mcp-search MCP server, skills and slash
 * commands all load from the plugin. `kimi install` therefore installs the
 * plugin the same way Kimi Code's own plugin manager does (verified against
 * MoonshotAI/kimi-code packages/agent-core-v2/src/app/plugin/):
 *
 *   $KIMI_CODE_HOME/plugins/managed/kimi-mem/   copy of the repo's plugin/ root
 *   $KIMI_CODE_HOME/plugins/installed.json      install record:
 *     { "version": 1, "plugins": [{ "id": "kimi-mem", "root": <managed abs>,
 *       "source": "local-path", "enabled": true, "installedAt": <ISO>,
 *       "updatedAt": <ISO>, "originalSource": "kimi-mem install" }] }
 *
 * $KIMI_CODE_HOME defaults to ~/.kimi-code. Other plugins in installed.json
 * are preserved; re-install replaces the managed copy and bumps updatedAt
 * while keeping installedAt. Plugin hook commands run with cwd = plugin root
 * and use `node scripts/bun-runner.js ...`, so no absolute paths are baked.
 *
 * The installer no longer writes `[[hooks]]` into config.toml or registers
 * mcp.json entries — those were the pre-plugin integration path.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { paths } from '../../shared/paths.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { getKimiCodeHome } from '../../cli/adapters/kimi.js';
import { getPluginRootAbsolutePath } from './install-paths.js';
import {
  fetchWithTimeout,
  getWorkerHost,
  getWorkerPort,
} from '../../shared/worker-utils.js';

const KIMI_PLUGIN_ID = 'kimi-mem';
const KIMI_PLUGIN_MANIFEST = 'kimi.plugin.json';
// Example values for the optional independent-API fallback shown in the
// post-install hint — not written to settings by default.
const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';
const MOONSHOT_DEFAULT_MODEL = 'kimi-k2.6';

const WORKER_HEALTH_TIMEOUT_MS = 1500;

interface KimiPluginInstallRecord {
  id: string;
  root: string;
  source: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  originalSource: string;
}

interface KimiInstalledPluginsFile {
  version: number;
  plugins: KimiPluginInstallRecord[];
  [key: string]: unknown;
}

function getKimiPluginsDir(): string {
  return path.join(getKimiCodeHome(), 'plugins');
}

function getInstalledJsonPath(): string {
  return path.join(getKimiPluginsDir(), 'installed.json');
}

function getManagedPluginRoot(): string {
  return path.join(getKimiPluginsDir(), 'managed', KIMI_PLUGIN_ID);
}

/**
 * Locate the plugin root to copy from. Probes the shared Rule-B candidates
 * (env vars, marketplace cache, cwd) plus the npm package layout (dist/ is a
 * sibling of the shipped plugin/ dir), and requires both the manifest and
 * scripts/ so a partial checkout cannot be installed.
 */
function findPluginSourceRoot(): string | null {
  let moduleDir = '';
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Bundled into worker-service.cjs — import.meta.url is unavailable or
    // points at the bundle; the env/marketplace/cwd probes still apply.
  }

  const candidates = [
    getPluginRootAbsolutePath(),
    moduleDir ? path.join(moduleDir, '..', '..', '..', 'plugin') : '',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (
      existsSync(path.join(candidate, KIMI_PLUGIN_MANIFEST))
      && existsSync(path.join(candidate, 'scripts'))
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Mirrors the plugin manager's copyPluginToManagedRoot: the managed copy is
 * replaced wholesale on every install. node_modules (473MB dev checkout,
 * absent from the npm tarball — plugin deps are bootstrapped by
 * version-check.js at runtime) and VCS metadata are never copied.
 */
function copyPluginToManagedRoot(sourceRoot: string, managedRoot: string): void {
  rmSync(managedRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(managedRoot), { recursive: true });
  cpSync(sourceRoot, managedRoot, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return name !== 'node_modules' && name !== '.git';
    },
  });
}

function readInstalledPluginsFile(filePath: string): KimiInstalledPluginsFile {
  const parsed = readJsonSafe<KimiInstalledPluginsFile | null>(filePath, null);
  if (parsed && Array.isArray(parsed.plugins)) {
    return { ...parsed, version: 1, plugins: parsed.plugins };
  }
  return { version: 1, plugins: [] };
}

/**
 * Insert or replace the kimi-mem record, preserving every other plugin.
 * installedAt survives re-installs; updatedAt always moves.
 */
function upsertInstallRecord(installedJsonPath: string, managedRoot: string): void {
  const file = readInstalledPluginsFile(installedJsonPath);
  const existing = file.plugins.find((plugin) => plugin?.id === KIMI_PLUGIN_ID);
  const now = new Date().toISOString();

  const record: KimiPluginInstallRecord = {
    id: KIMI_PLUGIN_ID,
    root: managedRoot,
    source: 'local-path',
    enabled: true,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    originalSource: existing?.originalSource ?? 'kimi-mem install',
  };

  file.plugins = [...file.plugins.filter((plugin) => plugin?.id !== KIMI_PLUGIN_ID), record];
  mkdirSync(path.dirname(installedJsonPath), { recursive: true });
  writeJsonFileAtomic(installedJsonPath, file);
}

function removeInstallRecord(installedJsonPath: string): boolean {
  if (!existsSync(installedJsonPath)) return false;

  const file = readInstalledPluginsFile(installedJsonPath);
  const kept = file.plugins.filter((plugin) => plugin?.id !== KIMI_PLUGIN_ID);
  if (kept.length === file.plugins.length) return false;

  file.plugins = kept;
  writeJsonFileAtomic(installedJsonPath, file);
  return true;
}

/**
 * Matches the Claude-oriented factory defaults (empty counts as unset): these
 * are meaningless to the kimi CLI and are normalized away on kimi installs so
 * settings.json never misleadingly shows "claude-haiku" as the model.
 */
const CLAUDE_STYLE_MODEL_DEFAULT = /^(|haiku|sonnet|opus|claude-.*)$/;
const blankIfClaudeDefault = (value: string | undefined): string =>
  CLAUDE_STYLE_MODEL_DEFAULT.test(value ?? '') ? '' : (value as string);

/**
 * Kimi Code installs already carry a logged-in `kimi` CLI, so the kimi
 * compression provider (which spawns it headlessly and reuses its configured
 * model + auth) is the zero-config default — no API key anywhere. Only
 * written when the provider is untouched at the 'claude' factory default and
 * no OpenRouter key is present; an explicit provider choice or existing key
 * is never overwritten.
 *
 * Model keys holding claude-style factory defaults (haiku/sonnet/claude-*)
 * are normalized to '' at the same time: with provider=kimi they are ignored
 * in favor of the CLI's own default_model, and blanking them keeps
 * settings.json honest. User-set kimi aliases are preserved.
 */
function ensureKimiProviderDefaults(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath, false);

  if (settings.KIMI_MEM_PROVIDER !== 'claude') return false;
  if (settings.KIMI_MEM_OPENROUTER_API_KEY) return false;

  writeJsonFileAtomic(settingsPath, {
    ...settings,
    KIMI_MEM_PROVIDER: 'kimi',
    KIMI_MEM_MODEL: blankIfClaudeDefault(settings.KIMI_MEM_MODEL),
    KIMI_MEM_TIER_SIMPLE_MODEL: blankIfClaudeDefault(settings.KIMI_MEM_TIER_SIMPLE_MODEL),
    KIMI_MEM_TIER_FAST_MODEL: blankIfClaudeDefault(settings.KIMI_MEM_TIER_FAST_MODEL),
    KIMI_MEM_TIER_SMART_MODEL: blankIfClaudeDefault(settings.KIMI_MEM_TIER_SMART_MODEL),
    KIMI_MEM_TIER_SUMMARY_MODEL: blankIfClaudeDefault(settings.KIMI_MEM_TIER_SUMMARY_MODEL),
  });
  return true;
}

export async function installKimiIntegration(): Promise<number> {
  console.log('\nInstalling Kimi-Mem for Kimi Code...\n');

  const sourceRoot = findPluginSourceRoot();
  if (!sourceRoot) {
    console.error(`Could not find the ${KIMI_PLUGIN_MANIFEST} plugin root`);
    console.error('   Expected in the kimi-mem package (plugin/ directory)');
    return 1;
  }

  const kimiHome = getKimiCodeHome();
  const managedRoot = getManagedPluginRoot();

  try {
    copyPluginToManagedRoot(sourceRoot, managedRoot);
    console.log(`  Installed plugin to ${managedRoot}`);

    upsertInstallRecord(getInstalledJsonPath(), managedRoot);
    console.log(`  Registered plugin "${KIMI_PLUGIN_ID}" in ${getInstalledJsonPath()}`);

    const providerConfigured = ensureKimiProviderDefaults();

    console.log(`
Installation complete!

Kimi Code home: ${kimiHome}
The plugin provides: SessionStart (warm worker), UserPromptSubmit (session-init + context-once),
       PostToolUse (observation), PreToolUse Read (file-context), Stop (summarize),
       the mcp-search MCP server, and the /kimi-mem:model command.

Next steps:
  1. Restart Kimi Code (or run /reload) so the plugin is loaded
  2. Optional: change the compression model inside Kimi Code with /kimi-mem:model <model>
`);

    if (providerConfigured) {
      console.log(`Compression provider:
  ${paths.settings()} was preconfigured with
    KIMI_MEM_PROVIDER=kimi
  Memory compression reuses your logged-in Kimi Code CLI and its default
  model — no API key or extra config needed.
  Prefer an independent OpenAI-compatible API instead? Set:
    KIMI_MEM_PROVIDER=openrouter
    KIMI_MEM_OPENROUTER_API_KEY=<your key>  (https://platform.moonshot.cn/)
    KIMI_MEM_OPENROUTER_BASE_URL=${MOONSHOT_BASE_URL}
    KIMI_MEM_OPENROUTER_MODEL=${MOONSHOT_DEFAULT_MODEL}
`);
    } else {
      console.log(`Compression provider: existing settings left untouched
  (${paths.settings()} already configures a provider or API key).
`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallKimiIntegration(): number {
  console.log('\nUninstalling Kimi-Mem Kimi Code integration...\n');

  try {
    if (removeInstallRecord(getInstalledJsonPath())) {
      console.log(`  Removed plugin "${KIMI_PLUGIN_ID}" from ${getInstalledJsonPath()}`);
    } else {
      console.log('  No kimi-mem record found in installed.json');
    }

    const managedRoot = getManagedPluginRoot();
    if (existsSync(managedRoot)) {
      rmSync(managedRoot, { recursive: true, force: true });
      console.log(`  Deleted managed plugin copy at ${managedRoot}`);
    } else {
      console.log('  No managed plugin copy found — nothing to delete');
    }

    console.log('\nUninstallation complete!');
    console.log(`Provider settings in ${paths.settings()} were left untouched.`);
    console.log('Restart Kimi Code (or run /reload) to unload the plugin.\n');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

export async function checkKimiIntegrationStatus(): Promise<number> {
  console.log('\nKimi-Mem Kimi Code Integration Status\n');

  const kimiHome = getKimiCodeHome();
  console.log(`Kimi Code home: ${kimiHome}${process.env.KIMI_CODE_HOME ? ' (via KIMI_CODE_HOME)' : ''}`);

  const installedJsonPath = getInstalledJsonPath();
  const record = readInstalledPluginsFile(installedJsonPath).plugins
    .find((plugin) => plugin?.id === KIMI_PLUGIN_ID);
  if (record) {
    const managedPresent = existsSync(record.root)
      && existsSync(path.join(record.root, KIMI_PLUGIN_MANIFEST));
    console.log(`Plugin: Installed (${record.enabled ? 'enabled' : 'DISABLED'}) at ${record.root}`);
    if (!managedPresent) {
      console.log('  Warning: managed plugin copy is missing — re-run `kimi-mem kimi install`');
    }
  } else {
    console.log(`Plugin: Not installed (no "${KIMI_PLUGIN_ID}" record in ${installedJsonPath})`);
  }

  try {
    const response = await fetchWithTimeout(
      `http://${getWorkerHost()}:${getWorkerPort()}/api/health`,
      {},
      WORKER_HEALTH_TIMEOUT_MS,
    );
    const health = await response.json() as { pid?: number; version?: string };
    console.log(`Worker: Running (pid ${health.pid ?? 'unknown'}${health.version ? `, v${health.version}` : ''})`);
  } catch {
    // Health probe — connection refused/timeout IS the "not running" answer.
    console.log('Worker: Not running (start it with `kimi-mem start`, or the plugin hooks auto-start it)');
  }

  const settings = SettingsDefaultsManager.loadFromFile(paths.settings(), false);
  const provider = settings.KIMI_MEM_PROVIDER;
  const hasKey = Boolean(settings.KIMI_MEM_OPENROUTER_API_KEY);
  if (provider === 'kimi') {
    const model = settings.KIMI_MEM_MODEL;
    console.log(`Provider: kimi (uses your logged-in Kimi Code CLI; model setting: ${model || 'default'})`);
  } else {
    console.log(`Provider: ${provider}${provider === 'openrouter' ? ` (model: ${settings.KIMI_MEM_OPENROUTER_MODEL || 'default'}, base URL: ${settings.KIMI_MEM_OPENROUTER_BASE_URL || 'openrouter.ai default'}, API key: ${hasKey ? 'set' : 'MISSING'})` : ''}`);
    if (provider === 'openrouter' && !hasKey) {
      console.log('  Hint: set KIMI_MEM_OPENROUTER_API_KEY in the settings file above to enable compression.');
    }
  }

  console.log('');
  return 0;
}

export async function handleKimiCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
    case 'setup':
      return installKimiIntegration();

    case 'uninstall':
      return uninstallKimiIntegration();

    case 'status':
      return checkKimiIntegrationStatus();

    default:
      console.log(`
Kimi-Mem Kimi Code Integration

Usage: kimi-mem kimi <command>

Commands:
  install     Install the Kimi Code plugin (copies plugin/ to $KIMI_CODE_HOME/plugins/managed/kimi-mem
              and registers it in plugins/installed.json)
  uninstall   Remove the plugin record and managed copy
  status      Check plugin + worker status

Examples:
  npm run kimi:install
  kimi-mem kimi install
  kimi-mem kimi status
      `);
      return 0;
  }
}
