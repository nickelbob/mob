import fs from 'fs';
import path from 'path';
import { getMobDir } from './util/platform.js';
import { DEFAULT_SETTINGS, mergeWithDefaults } from '../shared/settings.js';
import type { Settings } from '../shared/settings.js';
import { createLogger } from './util/logger.js';

const log = createLogger('settings');

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function validate(settings: Settings): Settings {
  settings.terminal.fontSize = clamp(Math.round(settings.terminal.fontSize), 8, 24);
  settings.terminal.scrollbackLines = clamp(Math.round(settings.terminal.scrollbackLines), 100, 100_000);
  settings.general.maxCachedTerminals = clamp(Math.round(settings.general.maxCachedTerminals), 1, 100);
  settings.general.staleThresholdSecs = clamp(Math.round(settings.general.staleThresholdSecs), 5, 300);

  const validCursorStyles = ['block', 'underline', 'bar'] as const;
  if (!validCursorStyles.includes(settings.terminal.cursorStyle as any)) {
    settings.terminal.cursorStyle = 'block';
  }

  // Strip trailing slashes from JIRA base URL
  if (settings.jira?.baseUrl) {
    settings.jira.baseUrl = settings.jira.baseUrl.replace(/\/+$/, '');
  }

  return settings;
}

export class SettingsManager {
  private settings: Settings;
  private filePath: string;

  constructor() {
    this.filePath = path.join(getMobDir(), 'settings.json');
    this.settings = this.load();
  }

  private load(): Settings {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const merged = mergeWithDefaults(parsed);
        return validate(merged);
      }
    } catch (err) {
      log.error('Failed to load settings, using defaults:', err);
    }
    return structuredClone(DEFAULT_SETTINGS);
  }

  private save(): void {
    const tmpPath = this.filePath + '.tmp';
    try {
      // mode on the tmp file, not chmod-after-rename: the file holds JIRA
      // tokens and must never be world-readable, even briefly. mode only
      // applies on creation, so drop any leftover tmp from a crashed save
      // (it may carry looser permissions from an older version).
      try { fs.unlinkSync(tmpPath); } catch { /* usually doesn't exist */ }
      fs.writeFileSync(tmpPath, JSON.stringify(this.settings, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      log.error('Failed to save settings:', err);
      // Clean up tmp file if rename failed
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  get(): Settings {
    return structuredClone(this.settings);
  }

  getRedacted(): Settings {
    const copy = structuredClone(this.settings);
    if (copy.jira) {
      copy.jira.apiToken = this.settings.jira?.apiToken ? '••••' : '';
      copy.jira.oauthClientSecret = this.settings.jira?.oauthClientSecret ? '••••' : '';
      copy.jira.oauthAccessToken = this.settings.jira?.oauthAccessToken ? '••••' : '';
      copy.jira.oauthRefreshToken = this.settings.jira?.oauthRefreshToken ? '••••' : '';
    }
    return copy;
  }

  update(partial: Record<string, any>): Settings {
    // Preserve existing secrets when redacted sentinel is sent from the UI
    if (partial.jira) {
      if (partial.jira.apiToken === '••••') partial.jira.apiToken = this.settings.jira.apiToken;
      if (partial.jira.oauthClientSecret === '••••') partial.jira.oauthClientSecret = this.settings.jira.oauthClientSecret;
      if (partial.jira.oauthAccessToken === '••••') partial.jira.oauthAccessToken = this.settings.jira.oauthAccessToken;
      if (partial.jira.oauthRefreshToken === '••••') partial.jira.oauthRefreshToken = this.settings.jira.oauthRefreshToken;
    }

    // Deep merge: start from current settings, overlay each section's partial fields
    const merged: any = structuredClone(this.settings);
    for (const section of Object.keys(partial)) {
      if (partial[section] && typeof partial[section] === 'object' && section in merged) {
        Object.assign(merged[section], partial[section]);
      } else if (section in merged) {
        merged[section] = partial[section];
      }
    }

    this.settings = validate(merged);
    this.save();
    return this.get();
  }
}
