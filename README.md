<h1 align="center">
  <br>
  <a href="https://github.com/YD-233/kimi-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YD-233/kimi-mem/main/docs/public/kimi-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/YD-233/kimi-mem/main/docs/public/kimi-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/YD-233/kimi-mem/main/docs/public/kimi-mem-logo-for-light-mode.webp" alt="kimi-mem" width="400">
    </picture>
  </a>
  <br>
</h1>

<h4 align="center">为 <a href="https://github.com/MoonshotAI/kimi-code">Kimi Code</a> 打造的跨会话持久记忆系统</h4>

<p align="center">
  🇨🇳 <b>中文（本文）</b> • <a href="docs/i18n/README.en.md">🇬🇧 English</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node"></a>
</p>

> **kimi-mem** 是 [claude-mem](https://github.com/thedotmack/claude-mem)（作者 [@thedotmack](https://github.com/thedotmack)，Apache-2.0）的 fork，针对 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 做了适配：压缩默认复用 Kimi Code 已登录的模型，安装为 Kimi Code 原生插件。

kimi-mem 让 AI 编程助手的上下文**跨会话存续**：自动捕获会话中的工具调用和对话，由 LLM 压缩成结构化记忆存入本地数据库，下次开会话时把相关记忆自动注入回去。会话结束、重启、换窗口，项目知识都不再丢失。

## 特性

- 🧠 **跨会话持久记忆** — 新会话自动注入该项目的历史记忆（每次会话只在首次提问时注入一次）
- 🗜️ **LLM 记忆压缩** — 默认复用你已登录的 Kimi Code 模型（含 config.toml 里配置的第三方模型），无需单独 API key
- 🔍 **自然语言搜索** — MCP 搜索工具 + mem-search 技能，三层渐进式检索节省 token
- 🔌 **原生插件形态** — 安装为 Kimi Code 插件（hooks / MCP / skills / 斜杠命令一体），可在插件管理器中启停
- 🖥️ **Web 实时面板** — worker 启动后可在浏览器查看记忆流（默认 http://localhost:37777 附近端口）
- 🔒 **隐私控制** — 用 `<private>` 标签排除敏感内容；数据全部存在本地 `~/.kimi-mem/`
- 🤖 **全自动运行** — 装好后零干预

## 快速开始

### 一键安装

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/YD-233/kimi-mem/main/install.ps1 | iex
```

**Linux / macOS：**

```bash
curl -fsSL https://raw.githubusercontent.com/YD-233/kimi-mem/main/install.sh | bash
```

脚本会：检查 node（≥20）→ 自动安装 bun（如缺失）→ 克隆仓库到 `~/.kimi-mem/repo` → 把插件安装进 Kimi Code（`plugins/managed/kimi-mem/` + `installed.json` 记录）。

装完**重启 Kimi Code（或 `/reload`）**，之后正常使用即可——记忆会自动积累。第二个会话起就能看到注入的历史上下文。

### 卸载

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/YD-233/kimi-mem/main/uninstall.ps1 | iex
```

**Linux / macOS：**

```bash
curl -fsSL https://raw.githubusercontent.com/YD-233/kimi-mem/main/uninstall.sh | bash
```

默认保留 `~/.kimi-mem` 里的记忆数据和配置；加 `--purge`（bash）/ `-Purge`（PowerShell）则彻底删除。

## 使用方法

### 压缩模型配置（斜杠命令）

在 Kimi Code 会话中：

- `/kimi-mem:model` — 弹出交互式选择器，列出 `~/.kimi-code/config.toml` 里所有可用的模型别名（`default_model`、`[secondary_model]` 第二模型、全部 `[models.*]`，含 deepseek 等第三方 provider），点选即完成切换
- `/kimi-mem:model 火山方舟/ark-code-latest` — 切换压缩模型为该别名，立即生效无需重启
- `/kimi-mem:model` 置空（或填 `haiku`/`claude-*` 这类值）= 跟随 Kimi Code 的 `default_model`

### 搜索记忆

- 直接问即可，例如"上次我们是怎么修那个登录 bug 的？"——agent 会自动调用 MCP 搜索工具
- 三个 MCP 工具按三层工作流省 token：`search`（索引）→ `timeline`（前后文）→ `get_observations`（按 ID 取详情）
- 也可以用 `/mem-search` 技能显式搜索

### 管理命令

```bash
# 在仓库目录下（默认 ~/.kimi-mem/repo）
bun plugin/scripts/worker-service.cjs kimi status      # 插件 + worker 状态
bun plugin/scripts/worker-service.cjs kimi uninstall   # 卸载插件（保留数据）
bun plugin/scripts/worker-service.cjs start|stop|restart|status   # worker 管理
bun plugin/scripts/worker-service.cjs search "<关键词>"            # 命令行搜索记忆
```

## 工作原理

```
Kimi Code 会话
   │  hooks（插件声明：SessionStart / UserPromptSubmit / PostToolUse / PreToolUse(Read) / Stop）
   ▼
worker-service.cjs hook kimi <事件>     ← 进程失败静默退出，绝不阻塞你的会话
   ▼
本地 worker 守护进程（HTTP API + Web 面板）
   ▼
LLM 压缩 ── 默认 provider=kimi：无头调用 kimi CLI，复用你的登录态和模型
   ▼
SQLite（~/.kimi-mem/kimi-mem.db）+ Chroma 向量库
   ▼
下次会话首次提问时 → 注入相关历史记忆
```

## 配置

配置文件：`~/.kimi-mem/settings.json`（首次运行自动创建）。

### 压缩提供方（provider）

**默认 `kimi`：复用 Kimi Code 的模型** —— 无头调用本机 `kimi` CLI，使用你的登录态和 `config.toml` 里的模型（包括你配置的第三方模型别名），**不需要 API key**：

```json
"KIMI_MEM_PROVIDER": "kimi",
"KIMI_MEM_MODEL": ""            // 留空 = 跟随 Kimi Code 的 default_model；填别名 = kimi -m <别名>
```

**可选：独立配置的 OpenAI 兼容 API**（另一把 Moonshot key、DeepSeek、本地 LM Studio 等）：

```json
"KIMI_MEM_PROVIDER": "openrouter",
"KIMI_MEM_OPENROUTER_API_KEY": "<你的 key>",
"KIMI_MEM_OPENROUTER_BASE_URL": "https://api.moonshot.cn/v1",
"KIMI_MEM_OPENROUTER_MODEL": "kimi-k2.6"
```

### 其他常用设置

| 设置 | 说明 |
| --- | --- |
| `KIMI_MEM_DATA_DIR` | 数据目录（默认 `~/.kimi-mem`） |
| `KIMI_MEM_MODE` | 观察记录的语言/工作流模式，中文用 `code--zh` |
| `KIMI_MEM_WORKER_PORT` | worker 端口（默认按 UID 派生，377xx） |
| `KIMI_MEM_EXCLUDED_PROJECTS` | 逗号分隔的目录列表，这些目录不记录记忆 |
| `KIMI_CLI_PATH` | 手动指定 kimi CLI 路径（默认自动探测） |

## 系统要求

- **Node.js** ≥ 20
- **Kimi Code**（已登录）
- **Bun**（一键脚本会自动安装）
- **uv**（可选，用于 Chroma 向量搜索，自动安装）

## 其他宿主

本 fork 保留了上游对 Claude Code、Codex、Cursor、Windsurf、OpenCode 等宿主的支持（见 `npx kimi-mem install --ide <名称>`，npm 包发布后可⽤），但主要维护和测试目标是 Kimi Code。

## 开发

```bash
npm install
npm run build          # 重新生成 plugin/scripts/*.cjs 等产物
npx tsc --noEmit       # 类型检查
bun test tests         # 测试
```

## 许可证与致谢

[Apache License 2.0](LICENSE)。上游项目：[claude-mem](https://github.com/thedotmack/claude-mem)，作者 Alex Newman（[@thedotmack](https://github.com/thedotmack)）。

- 问题反馈：[GitHub Issues](https://github.com/YD-233/kimi-mem/issues)
