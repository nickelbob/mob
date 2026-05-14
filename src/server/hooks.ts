import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'PermissionDenied',
  'Elicitation',
  'ElicitationResult',
];

function getHookCommand(packageRoot: string): string {
  if (process.platform === 'win32') {
    const hookScript = path.resolve(packageRoot, 'hooks', 'mob-status.ps1');
    const psPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return `"${psPath}" -NoProfile -ExecutionPolicy Bypass -File "${hookScript}"`;
  }
  const hookScript = path.resolve(packageRoot, 'hooks', 'mob-status.sh');
  return `bash "${hookScript}"`;
}

function readSettings(): Record<string, any> {
  const settingsDir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    } catch {
      // Corrupted settings — start fresh
    }
  }
  return {};
}

function writeSettings(settings: Record<string, any>): void {
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function isMobHook(entry: any): boolean {
  // New format: { matcher, hooks: [{ type, command }] }
  if (entry.hooks && Array.isArray(entry.hooks)) {
    return entry.hooks.some(
      (h: any) => h.type === 'command' && typeof h.command === 'string' && h.command.includes('mob-status')
    );
  }
  // Old format: { type, command }
  if (entry.type === 'command' && typeof entry.command === 'string' && entry.command.includes('mob-status')) {
    return true;
  }
  return false;
}

export function installHooks(packageRoot: string, quiet = false): void {
  const hookScript = process.platform === 'win32'
    ? path.resolve(packageRoot, 'hooks', 'mob-status.ps1')
    : path.resolve(packageRoot, 'hooks', 'mob-status.sh');

  if (!fs.existsSync(hookScript)) {
    if (!quiet) console.error(`Hook script not found: ${hookScript}`);
    return;
  }

  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  const hookCommand = getHookCommand(packageRoot);

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Remove any existing mob hooks (old or new format)
    settings.hooks[event] = settings.hooks[event].filter(
      (entry: any) => !isMobHook(entry)
    );

    // Add hook in current format
    settings.hooks[event].push({
      matcher: '',
      hooks: [{ type: 'command', command: hookCommand }],
    });
  }

  writeSettings(settings);
  if (!quiet) {
    console.log('Mob hooks installed successfully!');
    console.log(`Hook script: ${hookScript}`);
    console.log(`Events: ${HOOK_EVENTS.join(', ')}`);
  }
}

export function uninstallHooks(quiet = false): void {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    if (!quiet) console.log('No Claude settings found, nothing to uninstall.');
    return;
  }

  let settings: Record<string, any>;
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
  } catch {
    if (!quiet) console.error('Could not parse settings.json');
    return;
  }

  if (!settings.hooks) {
    if (!quiet) console.log('No hooks found in settings.');
    return;
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    if (Array.isArray(settings.hooks[event])) {
      const before = settings.hooks[event].length;
      settings.hooks[event] = settings.hooks[event].filter(
        (entry: any) => !isMobHook(entry)
      );
      removed += before - settings.hooks[event].length;

      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeSettings(settings);
  if (!quiet) console.log(`Removed ${removed} mob hook(s) from Claude settings.`);
}
