import React, { useState, useCallback, useEffect } from 'react';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { useContextPreview } from '../hooks/useContextPreview';
import { DEFAULT_SETTINGS } from '../constants/settings';

interface ContextSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (settings: Settings) => void;
  isSaving: boolean;
  saveStatus: string;
}

function CollapsibleSection({
  title,
  description,
  children,
  defaultOpen = true
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section-collapsible ${isOpen ? 'open' : ''}`}>
      <button
        className="section-header-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="section-header-content">
          <span className="section-title">{title}</span>
          {description && <span className="section-description">{description}</span>}
        </div>
        <svg
          className={`chevron-icon ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
}

function FormField({
  label,
  tooltip,
  children
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-field-label">
        {label}
        {tooltip && (
          <span className="tooltip-trigger" title={tooltip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  isSaving,
  saveStatus
}: ContextSettingsModalProps) {
  const [formState, setFormState] = useState<Settings>(settings);

  useEffect(() => {
    setFormState(settings);
  }, [settings]);

  const {
    preview,
    isLoading,
    error,
    projects,
    sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject
  } = useContextPreview(formState);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    const newState = { ...formState, [key]: value };
    setFormState(newState);
  }, [formState]);

  const handleSave = useCallback(() => {
    onSave(formState);
  }, [formState, onSave]);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    const currentValue = formState[key];
    const newValue = currentValue === 'true' ? 'false' : 'true';
    updateSetting(key, newValue);
  }, [formState, updateSetting]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>设置</h2>
          <div className="header-controls">
            <label className="preview-selector">
              来源：
              <select
                value={selectedSource || ''}
                onChange={(e) => setSelectedSource(e.target.value)}
                disabled={sources.length === 0}
              >
                {sources.map(source => (
                  <option key={source} value={source}>{source}</option>
                ))}
              </select>
            </label>
            <label className="preview-selector">
              项目：
              <select
                value={selectedProject || ''}
                onChange={(e) => setSelectedProject(e.target.value)}
                disabled={projects.length === 0}
              >
                {projects.map(project => (
                  <option key={project} value={project}>{project}</option>
                ))}
              </select>
            </label>
            <button
              onClick={onClose}
              className="modal-close-btn"
              title="关闭 (Esc)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <div className="preview-content">
              {error ? (
                <div style={{ color: '#ff6b6b' }}>
                  加载预览失败：{error}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} />
              )}
            </div>
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Section 1: Loading */}
            <CollapsibleSection
              title="加载"
              description="注入多少条观察记录"
            >
              <FormField
                label="观察记录数"
                tooltip="上下文中包含的最近观察记录数量（1-200）"
              >
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={formState.KIMI_MEM_CONTEXT_OBSERVATIONS || '50'}
                  onChange={(e) => updateSetting('KIMI_MEM_CONTEXT_OBSERVATIONS', e.target.value)}
                />
              </FormField>
              <FormField
                label="会话数"
                tooltip="提取观察记录的最近会话数量（1-50）"
              >
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={formState.KIMI_MEM_CONTEXT_SESSION_COUNT || '10'}
                  onChange={(e) => updateSetting('KIMI_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                />
              </FormField>
            </CollapsibleSection>

            {/* Section 2: Display */}
            <CollapsibleSection
              title="显示"
              description="上下文表格中显示哪些内容"
            >
              <div className="display-subsection">
                <span className="subsection-label">完整观察记录</span>
                <FormField
                  label="数量"
                  tooltip="显示完整详情的观察记录数量（0-20）"
                >
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={formState.KIMI_MEM_CONTEXT_FULL_COUNT || '5'}
                    onChange={(e) => updateSetting('KIMI_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                  />
                </FormField>
                <FormField
                  label="字段"
                  tooltip="完整观察记录要展开的字段"
                >
                  <select
                    value={formState.KIMI_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                    onChange={(e) => updateSetting('KIMI_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  >
                    <option value="narrative">叙述</option>
                    <option value="facts">事实</option>
                  </select>
                </FormField>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Token 统计</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label="读取成本"
                    description="读取这条观察记录所需的 token 数"
                    checked={formState.KIMI_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('KIMI_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label="工作投入"
                    description="生成这条观察记录消耗的 token 数"
                    checked={formState.KIMI_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('KIMI_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-savings-amount"
                    label="节省量"
                    description="复用上下文累计节省的 token 总数"
                    checked={formState.KIMI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('KIMI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 4: Advanced */}
            <CollapsibleSection
              title="高级"
              description="AI provider 与模型选择"
              defaultOpen={false}
            >
              <FormField
                label="AI Provider"
                tooltip="在 Claude（通过 Agent SDK）、Kimi Code CLI、Gemini（通过 REST API）或 OpenAI 兼容 API 之间选择"
              >
                <select
                  value={formState.KIMI_MEM_PROVIDER || 'claude'}
                  onChange={(e) => updateSetting('KIMI_MEM_PROVIDER', e.target.value)}
                >
                  <option value="claude">Claude（使用你的 Claude 账号）</option>
                  <option value="kimi">Kimi Code CLI（使用你的 kimi 登录）</option>
                  <option value="gemini">Gemini（使用 API key）</option>
                  <option value="openrouter">OpenRouter（多模型）</option>
                </select>
              </FormField>

              {formState.KIMI_MEM_PROVIDER === 'kimi' && (
                <FormField
                  label="Kimi 模型"
                  tooltip="以 `kimi -m <alias>` 的形式传给 kimi CLI 的模型别名（如 kimi-code/kimi-for-coding）。留空或填写 claude 风格的值（haiku/sonnet/opus/claude-*）时，使用 CLI 自身 ~/.kimi-code/config.toml 中的 default_model。"
                >
                  <input
                    type="text"
                    value={formState.KIMI_MEM_MODEL || ''}
                    onChange={(e) => updateSetting('KIMI_MEM_MODEL', e.target.value)}
                    placeholder="kimi default_model"
                  />
                </FormField>
              )}

              {formState.KIMI_MEM_PROVIDER === 'claude' && (
                <FormField
                  label="Claude 模型"
                  tooltip="用于生成观察记录的 Claude 模型"
                >
                  <select
                    value={formState.KIMI_MEM_MODEL || 'haiku'}
                    onChange={(e) => updateSetting('KIMI_MEM_MODEL', e.target.value)}
                  >
                    <option value="haiku">haiku（最快）</option>
                    <option value="sonnet">sonnet（均衡）</option>
                    <option value="opus">opus（最高质量）</option>
                  </select>
                </FormField>
              )}

              {formState.KIMI_MEM_PROVIDER === 'gemini' && (
                <>
                  <FormField
                    label="Gemini API Key"
                    tooltip="你的 Google AI Studio API key（或设置 GEMINI_API_KEY 环境变量）"
                  >
                    <input
                      type="password"
                      value={formState.KIMI_MEM_GEMINI_API_KEY || ''}
                      onChange={(e) => updateSetting('KIMI_MEM_GEMINI_API_KEY', e.target.value)}
                      placeholder="输入 Gemini API key..."
                    />
                  </FormField>
                  <FormField
                    label="Gemini 模型"
                    tooltip="用于生成观察记录的 Gemini 模型"
                  >
                    <select
                      value={formState.KIMI_MEM_GEMINI_MODEL || 'gemini-flash-latest'}
                      onChange={(e) => updateSetting('KIMI_MEM_GEMINI_MODEL', e.target.value)}
                    >
                      <option value="gemini-flash-latest">gemini-flash-latest（默认，最新 GA Flash）</option>
                      <option value="gemini-flash-lite-latest">gemini-flash-lite-latest（最新 GA Flash-Lite）</option>
                      <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                      <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                      <option value="gemini-3-flash-preview">gemini-3-flash-preview（预览版）</option>
                    </select>
                  </FormField>
                  <div className="toggle-group" style={{ marginTop: '8px' }}>
                    <ToggleSwitch
                      id="gemini-rate-limiting"
                      label="速率限制"
                      description="免费额度建议开启（10-30 RPM）；已开通计费可关闭（1000+ RPM）。"
                      checked={formState.KIMI_MEM_GEMINI_RATE_LIMITING_ENABLED === 'true'}
                      onChange={(checked) => updateSetting('KIMI_MEM_GEMINI_RATE_LIMITING_ENABLED', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              {formState.KIMI_MEM_PROVIDER === 'openrouter' && (
                <>
                  <FormField
                    label="OpenRouter API Key"
                    tooltip="你的 OpenRouter API key（来自 openrouter.ai，或设置 OPENROUTER_API_KEY 环境变量）"
                  >
                    <input
                      type="password"
                      value={formState.KIMI_MEM_OPENROUTER_API_KEY || ''}
                      onChange={(e) => updateSetting('KIMI_MEM_OPENROUTER_API_KEY', e.target.value)}
                      placeholder="输入 OpenRouter API key..."
                    />
                  </FormField>
                  <FormField
                    label="OpenRouter 模型"
                    tooltip="OpenRouter 的模型标识符（如 anthropic/claude-3.5-sonnet、google/gemini-2.0-flash-thinking-exp）"
                  >
                    <input
                      type="text"
                      value={formState.KIMI_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free'}
                      onChange={(e) => updateSetting('KIMI_MEM_OPENROUTER_MODEL', e.target.value)}
                      placeholder="例如 xiaomi/mimo-v2-flash:free"
                    />
                  </FormField>
                  <FormField
                    label="站点 URL（可选）"
                    tooltip="用于 OpenRouter 统计的站点 URL（可选）"
                  >
                    <input
                      type="text"
                      value={formState.KIMI_MEM_OPENROUTER_SITE_URL || ''}
                      onChange={(e) => updateSetting('KIMI_MEM_OPENROUTER_SITE_URL', e.target.value)}
                      placeholder="https://yoursite.com"
                    />
                  </FormField>
                  <FormField
                    label="应用名称（可选）"
                    tooltip="用于 OpenRouter 统计的应用名称（可选）"
                  >
                    <input
                      type="text"
                      value={formState.KIMI_MEM_OPENROUTER_APP_NAME || 'kimi-mem'}
                      onChange={(e) => updateSetting('KIMI_MEM_OPENROUTER_APP_NAME', e.target.value)}
                      placeholder="kimi-mem"
                    />
                  </FormField>
                </>
              )}

              <FormField
                label="Worker 端口"
                tooltip="后台 worker 服务使用的端口"
              >
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={formState.KIMI_MEM_WORKER_PORT || DEFAULT_SETTINGS.KIMI_MEM_WORKER_PORT}
                  onChange={(e) => updateSetting('KIMI_MEM_WORKER_PORT', e.target.value)}
                />
              </FormField>

              <div className="toggle-group" style={{ marginTop: '12px' }}>
                <ToggleSwitch
                  id="show-last-summary"
                  label="包含上次摘要"
                  description="将上一个会话的摘要加入上下文"
                  checked={formState.KIMI_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('KIMI_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <ToggleSwitch
                  id="show-last-message"
                  label="包含最后一条消息"
                  description="加入上一个会话的最后一条消息"
                  checked={formState.KIMI_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                  onChange={() => toggleBoolean('KIMI_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                />
              </div>
            </CollapsibleSection>
          </div>
        </div>

        {/* Footer with Save button */}
        <div className="modal-footer">
          <div className="save-status">
            {saveStatus && <span className={saveStatus.includes('✓') ? 'success' : saveStatus.includes('✗') ? 'error' : ''}>{saveStatus}</span>}
          </div>
          <button
            className="save-btn"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
