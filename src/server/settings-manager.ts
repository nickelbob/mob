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
      fs.writeFileSync(tmpPath, JSON.stringify(this.settings, null, 2), 'utf-8');
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
    }
    return copy;
  }

  update(partial: Record<string, any>): Settings {
    // If jira.apiToken comes in as the redacted sentinel, preserve existing token
    if (partial.jira && partial.jira.apiToken === '••••') {
      partial.jira.apiToken = this.settings.jira.apiToken;
    }

    const merged = mergeWithDefaults({ ...this.settings, ...partial });

    // Deep merge: for each section in partial, overlay onto current
    for (const section of Object.keys(partial)) {
      if (typeof partial[section] === 'object' && section in merged) {
        Object.assign((merged as any)[section], partial[section]);
      }
    }

    this.settings = validate(merged);
    this.save();
    return this.get();
  }
}
