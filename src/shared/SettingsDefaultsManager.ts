
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { HOOK_TIMEOUTS, getTimeout } from './hook-constants.js';
import { parseJsonWithBom, writeJsonFileAtomic } from './atomic-json.js';

// A fresh settings.json is seeded with EVERY default (see loadFromFile), and
// persisted values then win over DEFAULTS. So any install created after the
// Telegram notifier shipped (#2084) has that era's trigger list frozen on
// disk, and adding a type to the default list can never reach it — the new
// type would silently never notify. Rewrite the one exact legacy value to the
// current default; any other list is user-customized and is left untouched.
//
// This cannot distinguish a user who deliberately set exactly 'security_alert'
// from the seeded default — they read identically. Such a user is migrated and
// starts receiving `sensitive` notifications, which is the recoverable side of
// the trade: it is opt-out via this same key, whereas the alternative leaves
// the feature dead on arrival for every pre-existing install.
const LEGACY_TELEGRAM_TRIGGER_TYPES = 'security_alert';

export interface SettingsDefaults {
  KIMI_MEM_MODEL: string;
  KIMI_MEM_CONTEXT_OBSERVATIONS: string;
  KIMI_MEM_WORKER_PORT: string;
  KIMI_MEM_WORKER_HOST: string;
  KIMI_MEM_API_TIMEOUT_MS: string;
  KIMI_MEM_SKIP_TOOLS: string;
  KIMI_MEM_PROVIDER: string;  
  KIMI_MEM_CLAUDE_AUTH_METHOD: string;  
  KIMI_MEM_GEMINI_API_KEY: string;
  KIMI_MEM_GEMINI_MODEL: string;  
  KIMI_MEM_GEMINI_RATE_LIMITING_ENABLED: string;
  KIMI_MEM_OPENROUTER_API_KEY: string;
  KIMI_MEM_OPENROUTER_MODEL: string;
  KIMI_MEM_OPENROUTER_BASE_URL: string;
  KIMI_MEM_OPENROUTER_SITE_URL: string;
  KIMI_MEM_OPENROUTER_APP_NAME: string;
  KIMI_MEM_DATA_DIR: string;
  KIMI_MEM_LOG_LEVEL: string;
  KIMI_MEM_PYTHON_VERSION: string;
  CLAUDE_CODE_PATH: string;
  KIMI_MEM_MODE: string;
  KIMI_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  KIMI_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  KIMI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  KIMI_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  KIMI_MEM_CONTEXT_FULL_COUNT: string;
  KIMI_MEM_CONTEXT_FULL_FIELD: string;
  KIMI_MEM_CONTEXT_SESSION_COUNT: string;
  KIMI_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  KIMI_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
  KIMI_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  KIMI_MEM_WELCOME_HINT_ENABLED: string;
  KIMI_MEM_FOLDER_CLAUDEMD_ENABLED: string;
  KIMI_MEM_FOLDER_USE_LOCAL_MD: string;  
  KIMI_MEM_TRANSCRIPTS_ENABLED: string;  
  KIMI_MEM_TRANSCRIPTS_CONFIG_PATH: string;  
  KIMI_MEM_CODEX_TRANSCRIPT_INGESTION: string;
  KIMI_MEM_MAX_CONCURRENT_AGENTS: string;  
  KIMI_MEM_HOOK_FAIL_LOUD_THRESHOLD: string;  
  KIMI_MEM_EXCLUDED_PROJECTS: string;  
  KIMI_MEM_FOLDER_MD_EXCLUDE: string;
  KIMI_MEM_FOLDER_MD_SKELETON_DENYLIST: string;
  KIMI_MEM_SEMANTIC_INJECT: string;        
  KIMI_MEM_SEMANTIC_INJECT_LIMIT: string;  
  KIMI_MEM_TIER_ROUTING_ENABLED: string;
  KIMI_MEM_TIER_SIMPLE_MODEL: string;
  KIMI_MEM_TIER_SUMMARY_MODEL: string;
  KIMI_MEM_TIER_FAST_MODEL: string;        // #2289 — resolved by $TIER:fast in KIMI_MEM_MODEL
  KIMI_MEM_TIER_SMART_MODEL: string;       // #2289 — resolved by $TIER:smart in KIMI_MEM_MODEL
  KIMI_MEM_CHROMA_ENABLED: string;   
  KIMI_MEM_CHROMA_MODE: string;      
  KIMI_MEM_CHROMA_HOST: string;
  KIMI_MEM_CHROMA_PORT: string;
  KIMI_MEM_CHROMA_SSL: string;
  KIMI_MEM_CHROMA_API_KEY: string;
  KIMI_MEM_CHROMA_TENANT: string;
  KIMI_MEM_CHROMA_DATABASE: string;
  KIMI_MEM_CHROMA_PREWARM_TIMEOUT_MS: string;
  KIMI_MEM_CHROMA_MAX_PENDING_MUTATIONS: string;
  // Worker-native cloud sync. Active ⇔ TOKEN, USER_ID, and HUB_URL are all
  // non-empty — there is no separate enabled flag. HUB_URL points at the
  // two-lane sync hub (workers/sync-hub); while it is empty, sync is OFF
  // entirely (the old per-kind cmem.ai lane was deleted in the hub cutover).
  KIMI_MEM_CLOUD_SYNC_TOKEN: string;
  KIMI_MEM_CLOUD_SYNC_USER_ID: string;
  KIMI_MEM_CLOUD_SYNC_HUB_URL: string;
  KIMI_MEM_CLOUD_SYNC_DEVICE_ID: string;
  KIMI_MEM_CLOUD_SYNC_DEVICE_NAME: string;
  KIMI_MEM_CLOUD_SYNC_WS: string;    // advisory WebSocket speed layer (Phase 4) — 'false' = HTTP polling only
  KIMI_MEM_TELEGRAM_ENABLED: string;
  KIMI_MEM_TELEGRAM_BOT_TOKEN: string;
  KIMI_MEM_TELEGRAM_CHAT_ID: string;
  KIMI_MEM_TELEGRAM_TRIGGER_TYPES: string;
  KIMI_MEM_TELEGRAM_TRIGGER_CONCEPTS: string;
  KIMI_MEM_QUEUE_ENGINE: string;
  KIMI_MEM_REDIS_URL: string;
  KIMI_MEM_REDIS_HOST: string;
  KIMI_MEM_REDIS_PORT: string;
  KIMI_MEM_REDIS_MODE: string;
  KIMI_MEM_QUEUE_REDIS_PREFIX: string;
  KIMI_MEM_AUTH_MODE: string;
  KIMI_MEM_RUNTIME: string;
  // Phase 1a (cmem-sdk rename): canonical server settings keys. Hooks read
  // these first and fall back to the legacy `*_BETA_*` keys below.
  KIMI_MEM_SERVER_URL: string;
  KIMI_MEM_SERVER_API_KEY: string;
  KIMI_MEM_SERVER_PROJECT_ID: string;
  // Legacy keys retained for back-compat with existing settings.json files.
  KIMI_MEM_SERVER_BETA_URL: string;
  KIMI_MEM_SERVER_BETA_API_KEY: string;
  KIMI_MEM_SERVER_BETA_PROJECT_ID: string;
}

export class SettingsDefaultsManager {
  private static readonly DEFAULTS: SettingsDefaults = {
    KIMI_MEM_MODEL: 'claude-haiku-4-5-20251001',
    KIMI_MEM_CONTEXT_OBSERVATIONS: '50',
    KIMI_MEM_WORKER_PORT: String(37700 + ((process.getuid?.() ?? 77) % 100)),
    KIMI_MEM_WORKER_HOST: '127.0.0.1',
    KIMI_MEM_API_TIMEOUT_MS: String(getTimeout(HOOK_TIMEOUTS.API_REQUEST)),
    KIMI_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    KIMI_MEM_PROVIDER: 'claude',  // Default to Claude
    KIMI_MEM_CLAUDE_AUTH_METHOD: 'subscription',  // Default to logged-in Claude SDK auth (not API key)
    KIMI_MEM_GEMINI_API_KEY: '',  // Empty by default, can be set via UI or env
    KIMI_MEM_GEMINI_MODEL: 'gemini-flash-latest',  // Google-maintained alias → current GA Flash model (stays valid for new API keys)
    KIMI_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',  // Rate limiting ON by default for free tier users
    KIMI_MEM_OPENROUTER_API_KEY: '',  // Empty by default, can be set via UI or env
    KIMI_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',  // Default OpenRouter model (free tier)
    KIMI_MEM_OPENROUTER_BASE_URL: '',  // #2382/#2590/#2622/#2393 — optional OpenAI-compatible base URL (e.g. https://api.deepseek.com, http://localhost:1234/v1). Empty = default OpenRouter endpoint.
    KIMI_MEM_OPENROUTER_SITE_URL: '',  // Optional: for OpenRouter analytics
    KIMI_MEM_OPENROUTER_APP_NAME: 'kimi-mem',  // App name for OpenRouter analytics
    KIMI_MEM_DATA_DIR: join(homedir(), '.kimi-mem'),
    KIMI_MEM_LOG_LEVEL: 'INFO',
    KIMI_MEM_PYTHON_VERSION: '3.13',
    CLAUDE_CODE_PATH: '', // Empty means auto-detect via 'which claude'
    KIMI_MEM_MODE: 'code', // Default mode profile
    KIMI_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
    KIMI_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
    KIMI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
    KIMI_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    KIMI_MEM_CONTEXT_FULL_COUNT: '0',
    KIMI_MEM_CONTEXT_FULL_FIELD: 'narrative',
    KIMI_MEM_CONTEXT_SESSION_COUNT: '10',
    KIMI_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    KIMI_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    KIMI_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    KIMI_MEM_WELCOME_HINT_ENABLED: 'true',
    KIMI_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    KIMI_MEM_FOLDER_USE_LOCAL_MD: 'false',  // When true, writes to CLAUDE.local.md instead of CLAUDE.md
    KIMI_MEM_TRANSCRIPTS_ENABLED: 'true',
    KIMI_MEM_TRANSCRIPTS_CONFIG_PATH: join(homedir(), '.kimi-mem', 'transcript-watch.json'),
    KIMI_MEM_CODEX_TRANSCRIPT_INGESTION: 'false',
    KIMI_MEM_MAX_CONCURRENT_AGENTS: '2',  // Max concurrent Claude SDK agent subprocesses
    KIMI_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',  // Plan 05 Phase 8 — escalate to exit code 2 after N consecutive worker-unreachable hook invocations
    KIMI_MEM_EXCLUDED_PROJECTS: '',  // Comma-separated glob patterns for excluded project paths
    KIMI_MEM_FOLDER_MD_EXCLUDE: '[]',  // JSON array of folder paths to exclude from CLAUDE.md generation
    KIMI_MEM_FOLDER_MD_SKELETON_DENYLIST: '[]',  // #2400 — JSON array of glob patterns; when a folder matches AND its generated CLAUDE.md would be empty/skeleton, skip injection (avoids polluting non-content dirs with empty skeletons). Default [] preserves existing behavior.
    KIMI_MEM_SEMANTIC_INJECT: 'false',             // Inject relevant past observations on every UserPromptSubmit (experimental, disabled by default)
    KIMI_MEM_SEMANTIC_INJECT_LIMIT: '5',           // Top-N most relevant observations to inject per prompt
    KIMI_MEM_TIER_ROUTING_ENABLED: 'true',         // Route observations to models by complexity
    KIMI_MEM_TIER_SIMPLE_MODEL: 'haiku', // Portable tier alias — works across Direct API, Bedrock, Vertex, Azure (see #1463)
    KIMI_MEM_TIER_SUMMARY_MODEL: '',                // Empty = use default model for summaries
    KIMI_MEM_TIER_FAST_MODEL: 'haiku',              // #2289 — $TIER:fast resolves here (portable alias)
    KIMI_MEM_TIER_SMART_MODEL: 'sonnet',            // #2289 — $TIER:smart resolves here (portable alias)
    KIMI_MEM_CHROMA_ENABLED: 'true',         // Set to 'false' to disable Chroma and use SQLite-only search
    KIMI_MEM_CHROMA_MODE: 'local',           // 'local' uses persistent chroma-mcp via uvx, 'remote' connects to existing server
    KIMI_MEM_CHROMA_HOST: '127.0.0.1',
    KIMI_MEM_CHROMA_PORT: '8000',
    KIMI_MEM_CHROMA_SSL: 'false',
    KIMI_MEM_CHROMA_API_KEY: '',
    KIMI_MEM_CHROMA_TENANT: 'default_tenant',
    KIMI_MEM_CHROMA_DATABASE: 'default_database',
    KIMI_MEM_CHROMA_PREWARM_TIMEOUT_MS: '120000',
    KIMI_MEM_CHROMA_MAX_PENDING_MUTATIONS: '5000', // Bound burst imports without changing normal live indexing
    // Worker-native cloud sync: credentials come from cmem.ai → Connect.
    KIMI_MEM_CLOUD_SYNC_TOKEN: '',
    KIMI_MEM_CLOUD_SYNC_USER_ID: '',
    KIMI_MEM_CLOUD_SYNC_HUB_URL: '',  // sync-hub base URL (e.g. https://sync.cmem.ai). Empty = sync OFF
    KIMI_MEM_CLOUD_SYNC_DEVICE_ID: '',      // Minted at first CloudSync start, then persisted back here
    KIMI_MEM_CLOUD_SYNC_DEVICE_NAME: hostname(),  // Human-readable label for the cmem.ai Devices panel
    KIMI_MEM_CLOUD_SYNC_WS: 'true',  // Advisory WebSocket speed layer (plan Phase 4). 'false' = HTTP polling only — sync stays fully correct, just poll-latency (prime directive #2)
    KIMI_MEM_TELEGRAM_ENABLED: 'true',
    KIMI_MEM_TELEGRAM_BOT_TOKEN: '',
    KIMI_MEM_TELEGRAM_CHAT_ID: '',
    KIMI_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert,sensitive',
    KIMI_MEM_TELEGRAM_TRIGGER_CONCEPTS: '',
    KIMI_MEM_QUEUE_ENGINE: 'sqlite',
    KIMI_MEM_REDIS_URL: '',
    KIMI_MEM_REDIS_HOST: '127.0.0.1',
    KIMI_MEM_REDIS_PORT: '6379',
    KIMI_MEM_REDIS_MODE: 'external',
    KIMI_MEM_QUEUE_REDIS_PREFIX: `kimi_mem_${process.env.KIMI_MEM_WORKER_PORT ?? String(37700 + ((process.getuid?.() ?? 77) % 100))}`,
    KIMI_MEM_AUTH_MODE: 'api-key',
    KIMI_MEM_RUNTIME: 'worker',
    // Phase 1a (cmem-sdk rename): canonical server settings keys. Hooks read
    // these first; the legacy `*_BETA_*` defaults below remain so existing
    // settings.json files still resolve correctly.
    KIMI_MEM_SERVER_URL: `http://127.0.0.1:${process.env.KIMI_MEM_SERVER_PORT ?? String(37877 + ((process.getuid?.() ?? 77) % 100))}`,  // Default server runtime URL — UID-derived for multi-account isolation
    KIMI_MEM_SERVER_API_KEY: '',                          // Local hook API key, populated by installer when runtime=server
    KIMI_MEM_SERVER_PROJECT_ID: '',                       // Default Postgres project_id used by hooks when runtime=server
    KIMI_MEM_SERVER_BETA_URL: `http://127.0.0.1:${process.env.KIMI_MEM_SERVER_PORT ?? String(37877 + ((process.getuid?.() ?? 77) % 100))}`,  // Legacy server-beta runtime URL — UID-derived for multi-account isolation
    KIMI_MEM_SERVER_BETA_API_KEY: '',                     // Legacy local hook API key (read as fallback when KIMI_MEM_SERVER_API_KEY unset)
    KIMI_MEM_SERVER_BETA_PROJECT_ID: '',                  // Legacy Postgres project_id (read as fallback when KIMI_MEM_SERVER_PROJECT_ID unset)
  };

  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  static get(key: keyof SettingsDefaults): string {
    return process.env[key] ?? this.DEFAULTS[key];
  }

  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  private static applyEnvOverrides(settings: SettingsDefaults): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  static loadFromFile(settingsPath: string, applyEnvOverrides = true): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          writeJsonFileAtomic(settingsPath, defaults);
          // stderr, never stdout: this fires on the first boot in a fresh data
          // dir, and CLI commands like `start` promise machine-readable JSON
          // on stdout to the hook framework.
          console.warn('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error instanceof Error ? error.message : String(error));
        }
        return applyEnvOverrides ? this.applyEnvOverrides(defaults) : defaults;
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = parseJsonWithBom<Record<string, any>>(settingsData);

      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        flatSettings = settings.env;

        try {
          writeJsonFileAtomic(settingsPath, flatSettings);
          // stderr, never stdout — same JSON-on-stdout contract as above.
          console.warn('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error instanceof Error ? error.message : String(error));
          // Continue with in-memory migration even if write fails
        }
      }

      if (flatSettings.KIMI_MEM_TELEGRAM_TRIGGER_TYPES === LEGACY_TELEGRAM_TRIGGER_TYPES) {
        flatSettings = {
          ...flatSettings,
          KIMI_MEM_TELEGRAM_TRIGGER_TYPES: this.DEFAULTS.KIMI_MEM_TELEGRAM_TRIGGER_TYPES,
        };

        try {
          writeJsonFileAtomic(settingsPath, flatSettings);
          // stderr, never stdout — same JSON-on-stdout contract as above.
          console.warn('[SETTINGS] Migrated Telegram trigger types off the legacy default:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to migrate Telegram trigger types:', settingsPath, error instanceof Error ? error.message : String(error));
          // Continue with the in-memory migration even if the write fails
        }
      }

      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      return applyEnvOverrides ? this.applyEnvOverrides(result) : result;
    } catch (error: unknown) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error instanceof Error ? error.message : String(error));
      const defaults = this.getAllDefaults();
      return applyEnvOverrides ? this.applyEnvOverrides(defaults) : defaults;
    }
  }
}
