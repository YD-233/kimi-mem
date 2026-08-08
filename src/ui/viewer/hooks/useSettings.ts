import { useState, useEffect } from 'react';
import { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    fetch(API_ENDPOINTS.SETTINGS)
      .then(async res => {
        if (!res.ok) {
          throw new Error(`Failed to load settings (${res.status})`);
        }
        return res.json();
      })
      .then(data => {
        setSettings({ ...DEFAULT_SETTINGS, ...data });
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
      });
  }, []);

  const submitSettings = async (newSettings: Settings) => {
    const response = await fetch(API_ENDPOINTS.SETTINGS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });

    if (!response.ok) {
      setSaveStatus(`✗ 错误：${response.status === 401 ? '未授权' : response.statusText}`);
      setIsSaving(false);
      return;
    }

    const result = await response.json();

    if (result.success) {
      setSettings(newSettings);
      setSaveStatus('✓ 已保存');
      setTimeout(() => setSaveStatus(''), TIMING.SAVE_STATUS_DISPLAY_DURATION_MS);
    } else {
      setSaveStatus(`✗ 错误：${result.error}`);
    }
  };

  const saveSettings = async (newSettings: Settings) => {
    setIsSaving(true);
    setSaveStatus('保存中...');

    try {
      await submitSettings(newSettings);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaveStatus(`✗ 错误：${error instanceof Error ? error.message : '网络错误'}`);
    }

    setIsSaving(false);
  };

  return { settings, saveSettings, isSaving, saveStatus };
}
