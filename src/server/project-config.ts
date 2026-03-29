import fs from 'fs';
import path from 'path';
import { createLogger } from './util/logger.js';

const log = createLogger('project-config');

export interface ProjectConfig {
  setup?: string[];
  teardown?: string[];
  defaults?: {
    model?: string;
    permissionMode?: string;
    autoName?: boolean;
  };
}

/**
 * Load .mob/config.json from a project directory.
 * Returns null if not found or invalid.
 */
export function loadProjectConfig(cwd: string): ProjectConfig | null {
  const configPath = path.join(cwd, '.mob', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);

    // Basic validation
    const config: ProjectConfig = {};

    if (Array.isArray(parsed.setup) && parsed.setup.every((s: unknown) => typeof s === 'string')) {
      config.setup = parsed.setup;
    }
    if (Array.isArray(parsed.teardown) && parsed.teardown.every((s: unknown) => typeof s === 'string')) {
      config.teardown = parsed.teardown;
    }
    if (parsed.defaults && typeof parsed.defaults === 'object') {
      config.defaults = {};
      if (typeof parsed.defaults.model === 'string') config.defaults.model = parsed.defaults.model;
      if (typeof parsed.defaults.permissionMode === 'string') config.defaults.permissionMode = parsed.defaults.permissionMode;
      if (typeof parsed.defaults.autoName === 'boolean') config.defaults.autoName = parsed.defaults.autoName;
    }

    log.info(`Loaded project config from ${configPath}`);
    return config;
  } catch {
    return null;
  }
}
