/**
 * KimiHooksInstaller.ts — Rule B installer for Kimi Code (MoonshotAI).
 *
 * Writes kimi-mem's hooks into Kimi's user config and registers the MCP
 * search server:
 *
 *   $KIMI_CODE_HOME/config.toml   `[[hooks]]` array-of-tables (strict schema:
 *                                 event / matcher / command / timeout only)
 *   $KIMI_CODE_HOME/mcp.json      { "mcpServers": { "mcp-search": ... } }
 *
 * $KIMI_CODE_HOME defaults to ~/.kimi-code. Hook commands bake absolute paths
 * (bun + worker-service.cjs — the bundle eagerly requires bun:sqlite, so plain
 * node cannot run it) because config.toml hooks get no env-var substitution
 * from the host — only plugin-manifest hooks receive KIMI_PLUGIN_ROOT (see
 * plugin/kimi.plugin.json).
 *
 * Event mapping (verified against MoonshotAI/kimi-code agent-core-v2):
 *   SessionStart     -> `start` (warm the worker; SessionStart stdout is NOT
 *                       injected into context by Kimi — observation-only)
 *   UserPromptSubmit -> `hook kimi session-init` AND `hook kimi context-once`
 *                       (two entries; distinct command strings so Kimi's
 *                       (cwd, command) dedupe keeps both; UserPromptSubmit is
 *                       the only event whose stdout reaches model context)
 *   PostToolUse(*)   -> `hook kimi observation`
 *   PreToolUse(Read) -> `hook kimi file-context`
 *   Stop             -> `hook kimi summarize`
 */
import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { paths } from '../../shared/paths.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { getKimiCodeHome } from '../../cli/adapters/kimi.js';
import {
  getMcpServerAbsolutePath,
  getWorkerServiceAbsolutePath,
  getNodeAbsolutePath,
  getBunAbsolutePath,
} from './install-paths.js';

const MCP_SERVER_NAME = 'mcp-search';
const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';
const MOONSHOT_DEFAULT_MODEL = 'kimi-k3';
const OPENROUTER_FALLBACK_DEFAULT_MODEL = 'xiaomi/mimo-v2-flash:free';

interface KimiHookEntry {
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';
  matcher?: string;
  command: string;
  timeout?: number;
}

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function getKimiConfigTomlPath(): string {
  return path.join(getKimiCodeHome(), 'config.toml');
}

function getKimiMcpJsonPath(): string {
  return path.join(getKimiCodeHome(), 'mcp.json');
}

export function buildKimiHookEntries(workerServicePath: string): KimiHookEntry[] {
  // worker-service.cjs eagerly requires bun:sqlite at module load, so hook
  // commands must run under Bun (same as the Cursor integration); plain node
  // crashes before dispatch. getBunAbsolutePath falls back to the bare `bun`
  // name resolved via PATH at exec time.
  const bun = getBunAbsolutePath();
  const run = (...args: string[]) => `"${bun}" "${workerServicePath}" ${args.join(' ')}`;

  return [
    // Warm the worker at session start. Kimi discards SessionStart stdout, so
    // the status JSON `start` prints never reaches the model.
    { event: 'SessionStart', command: run('start'), timeout: 60 },
    // First-prompt context injection (once per session; see context-once.ts).
    { event: 'UserPromptSubmit', command: run('hook', 'kimi', 'context-once'), timeout: 60 },
    // Session registration on every prompt (idempotent server-side).
    { event: 'UserPromptSubmit', command: run('hook', 'kimi', 'session-init'), timeout: 60 },
    { event: 'PostToolUse', command: run('hook', 'kimi', 'observation') },
    { event: 'PreToolUse', matcher: 'Read', command: run('hook', 'kimi', 'file-context') },
    { event: 'Stop', command: run('hook', 'kimi', 'summarize') },
  ];
}

function renderHookEntryToml(entry: KimiHookEntry): string {
  const lines = [
    '[[hooks]]',
    '# kimi-mem (kimi-mem) managed hook — removed by `kimi-mem kimi uninstall`.',
    `event = ${tomlBasicString(entry.event)}`,
  ];
  if (entry.matcher !== undefined) {
    lines.push(`matcher = ${tomlBasicString(entry.matcher)}`);
  }
  lines.push(`command = ${tomlBasicString(entry.command)}`);
  if (entry.timeout !== undefined) {
    lines.push(`timeout = ${entry.timeout}`);
  }
  return lines.join('\n');
}

function tomlHeader(line: string): { kind: 'table' | 'array-table'; name: string } | null {
  const trimmed = line.trim();
  const arrayMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
  if (arrayMatch) return { kind: 'array-table', name: arrayMatch[1].trim() };
  const tableMatch = trimmed.match(/^\[([^\]]+)\]$/);
  if (tableMatch) return { kind: 'table', name: tableMatch[1].trim() };
  return null;
}

/**
 * Remove only the `[[hooks]]` blocks kimi-mem owns (identified by the
 * `worker-service.cjs` reference in their command). Every other line of the
 * user's config.toml — including their own `[[hooks]]` entries — is preserved
 * verbatim.
 */
export function removeKimiHookBlocks(content: string): { result: string; removed: number } {
  const lines = content.split('\n');
  const blocks: Array<{ header: ReturnType<typeof tomlHeader>; text: string }> = [];
  let currentHeader: ReturnType<typeof tomlHeader> = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const header = tomlHeader(line);
    if (header !== null) {
      blocks.push({ header: currentHeader, text: currentLines.join('\n') });
      currentHeader = header;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  blocks.push({ header: currentHeader, text: currentLines.join('\n') });

  const isOurs = (block: { header: ReturnType<typeof tomlHeader>; text: string }): boolean =>
    block.header?.kind === 'array-table'
    && block.header.name === 'hooks'
    && block.text.includes('worker-service.cjs');

  const removed = blocks.filter(isOurs).length;
  if (removed === 0) return { result: content, removed: 0 };

  const kept = blocks.filter((block) => !isOurs(block));
  const result = kept
    .map((block) => block.text)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return { result: result.length > 0 ? `${result}\n` : '', removed };
}

function installHooksIntoConfigToml(workerServicePath: string): number {
  const configPath = getKimiConfigTomlPath();
  mkdirSync(path.dirname(configPath), { recursive: true });

  const entries = buildKimiHookEntries(workerServicePath);
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const { result: stripped } = removeKimiHookBlocks(current);
  const body = stripped.trimEnd();
  const next = `${body}${body ? '\n\n' : ''}${entries.map(renderHookEntryToml).join('\n\n')}\n`;

  // Idempotent: stripping our blocks and re-appending them reproduces the
  // exact same file when the install is already current.
  if (next !== current) {
    writeFileSync(configPath, next);
  }
  return entries.length;
}

function configureKimiMcp(mcpServerPath: string): void {
  const mcpJsonPath = getKimiMcpJsonPath();
  mkdirSync(path.dirname(mcpJsonPath), { recursive: true });

  const existingConfig = readJsonSafe<Record<string, any>>(mcpJsonPath, {});
  if (!existingConfig.mcpServers || typeof existingConfig.mcpServers !== 'object') {
    existingConfig.mcpServers = {};
  }
  existingConfig.mcpServers[MCP_SERVER_NAME] = {
    command: getNodeAbsolutePath(),
    args: [mcpServerPath],
  };

  writeJsonFileAtomic(mcpJsonPath, existingConfig);
}

function removeKimiMcp(): boolean {
  const mcpJsonPath = getKimiMcpJsonPath();
  if (!existsSync(mcpJsonPath)) return false;

  const existingConfig = readJsonSafe<Record<string, any>>(mcpJsonPath, {});
  const entry = existingConfig?.mcpServers?.[MCP_SERVER_NAME];
  if (!entry) return false;

  // Only remove the entry if it points at kimi-mem's server — a user-owned
  // server that happens to share the name must survive uninstall.
  const entryText = JSON.stringify(entry);
  if (!entryText.includes('mcp-server.cjs')) return false;

  delete existingConfig.mcpServers[MCP_SERVER_NAME];
  writeJsonFileAtomic(mcpJsonPath, existingConfig);
  return true;
}

/**
 * Kimi users do not have the `claude` CLI the default compression provider
 * spawns. When nothing is configured yet (provider untouched at the 'claude'
 * default and no OpenRouter key present), point the OpenAI-compatible provider
 * at Moonshot's API and leave the API key for the user to fill in. Never
 * overwrites an explicit provider choice or an existing key/model/base URL.
 */
function ensureMoonshotProviderDefaults(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath, false);

  if (settings.KIMI_MEM_PROVIDER !== 'claude') return false;
  if (settings.KIMI_MEM_OPENROUTER_API_KEY) return false;

  const model = settings.KIMI_MEM_OPENROUTER_MODEL;
  writeJsonFileAtomic(settingsPath, {
    ...settings,
    KIMI_MEM_PROVIDER: 'openrouter',
    KIMI_MEM_OPENROUTER_BASE_URL: settings.KIMI_MEM_OPENROUTER_BASE_URL || MOONSHOT_BASE_URL,
    KIMI_MEM_OPENROUTER_MODEL:
      !model || model === OPENROUTER_FALLBACK_DEFAULT_MODEL ? MOONSHOT_DEFAULT_MODEL : model,
  });
  return true;
}

export async function installKimiHooks(): Promise<number> {
  console.log('\nInstalling Kimi-Mem for Kimi Code...\n');

  const workerServicePath = getWorkerServiceAbsolutePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/YD-233/plugin/scripts/worker-service.cjs');
    return 1;
  }
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    console.error('Could not find mcp-server.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/YD-233/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  const kimiHome = getKimiCodeHome();

  try {
    const hookCount = installHooksIntoConfigToml(workerServicePath);
    console.log(`  Wrote ${hookCount} [[hooks]] entries to ${getKimiConfigTomlPath()}`);

    configureKimiMcp(mcpServerPath);
    console.log(`  Configured MCP server "${MCP_SERVER_NAME}" in ${getKimiMcpJsonPath()}`);

    const providerConfigured = ensureMoonshotProviderDefaults();

    console.log(`
Installation complete!

Kimi Code home: ${kimiHome}
Hooks: SessionStart (warm worker), UserPromptSubmit (session-init + context-once),
       PostToolUse (observation), PreToolUse Read (file-context), Stop (summarize)

Next steps:
  1. Restart any running Kimi Code sessions so the new hooks are loaded
  2. Start kimi-mem worker: kimi-mem start (the hooks also auto-start it)
`);

    if (providerConfigured) {
      console.log(`Compression provider:
  kimi-mem's default provider spawns the Claude CLI, which Kimi Code setups
  usually lack. ${paths.settings()} was preconfigured for Moonshot's
  OpenAI-compatible API:
    KIMI_MEM_PROVIDER=openrouter
    KIMI_MEM_OPENROUTER_BASE_URL=${MOONSHOT_BASE_URL}
    KIMI_MEM_OPENROUTER_MODEL=${MOONSHOT_DEFAULT_MODEL}
  Set your Moonshot API key to enable memory compression:
    KIMI_MEM_OPENROUTER_API_KEY=<your key>  (https://platform.moonshot.cn/)
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

export function uninstallKimiHooks(): number {
  console.log('\nUninstalling Kimi-Mem Kimi Code integration...\n');

  try {
    const configPath = getKimiConfigTomlPath();
    if (existsSync(configPath)) {
      const current = readFileSync(configPath, 'utf-8');
      const { result, removed } = removeKimiHookBlocks(current);
      if (removed > 0) {
        writeFileSync(configPath, result);
        console.log(`  Removed ${removed} kimi-mem [[hooks]] entries from ${configPath}`);
      } else {
        console.log('  No kimi-mem hooks found in config.toml');
      }
    } else {
      console.log('  No config.toml found — nothing to remove');
    }

    if (removeKimiMcp()) {
      console.log(`  Removed MCP server "${MCP_SERVER_NAME}" from ${getKimiMcpJsonPath()}`);
    } else {
      console.log('  No kimi-mem MCP entry found in mcp.json');
    }

    console.log('\nUninstallation complete!');
    console.log(`Provider settings in ${paths.settings()} were left untouched.`);
    console.log('Restart Kimi Code to apply changes.\n');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

export function checkKimiHooksStatus(): number {
  console.log('\nKimi-Mem Kimi Code Integration Status\n');

  const kimiHome = getKimiCodeHome();
  console.log(`Kimi Code home: ${kimiHome}${process.env.KIMI_CODE_HOME ? ' (via KIMI_CODE_HOME)' : ''}`);

  const configPath = getKimiConfigTomlPath();
  if (existsSync(configPath)) {
    const { removed } = removeKimiHookBlocks(readFileSync(configPath, 'utf-8'));
    if (removed > 0) {
      console.log(`Hooks: Installed (${removed} kimi-mem [[hooks]] entries in ${configPath})`);
    } else {
      console.log(`Hooks: Not installed (no kimi-mem entries in ${configPath})`);
    }
  } else {
    console.log(`Hooks: Not installed (${configPath} does not exist)`);
  }

  const mcpJsonPath = getKimiMcpJsonPath();
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = readJsonSafe<Record<string, any>>(mcpJsonPath, {});
      const entry = mcpConfig?.mcpServers?.[MCP_SERVER_NAME];
      console.log(entry
        ? `MCP:   Configured ("${MCP_SERVER_NAME}" in ${mcpJsonPath})`
        : `MCP:   Not configured (no "${MCP_SERVER_NAME}" entry in ${mcpJsonPath})`);
    } catch (error) {
      logger.warn('WORKER', 'Unable to parse kimi mcp.json', { path: mcpJsonPath, error: error instanceof Error ? error.message : String(error) });
      console.log('MCP:   Unable to parse mcp.json');
    }
  } else {
    console.log(`MCP:   Not configured (${mcpJsonPath} does not exist)`);
  }

  const settings = SettingsDefaultsManager.loadFromFile(paths.settings(), false);
  const provider = settings.KIMI_MEM_PROVIDER;
  const hasKey = Boolean(settings.KIMI_MEM_OPENROUTER_API_KEY);
  console.log(`Provider: ${provider}${provider === 'openrouter' ? ` (base URL: ${settings.KIMI_MEM_OPENROUTER_BASE_URL || 'openrouter.ai default'}, API key: ${hasKey ? 'set' : 'MISSING'})` : ''}`);
  if (provider === 'openrouter' && !hasKey) {
    console.log('  Hint: set KIMI_MEM_OPENROUTER_API_KEY in the settings file above to enable compression.');
  }

  console.log('');
  return 0;
}

export async function handleKimiCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
    case 'setup':
      return installKimiHooks();

    case 'uninstall':
      return uninstallKimiHooks();

    case 'status':
      return checkKimiHooksStatus();

    default:
      console.log(`
Kimi-Mem Kimi Code Integration

Usage: kimi-mem kimi <command>

Commands:
  install     Install Kimi Code hooks + MCP config (writes $KIMI_CODE_HOME/config.toml and mcp.json)
  uninstall   Remove Kimi Code hooks + MCP config
  status      Check installation status

Examples:
  npm run kimi:install
  kimi-mem kimi install
  kimi-mem kimi status
      `);
      return 0;
  }
}
