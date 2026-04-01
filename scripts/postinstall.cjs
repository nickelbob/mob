// Checks for missing platform-specific native dependencies and installs them.
// npm has a known bug (https://github.com/npm/cli/issues/4828) where optional
// native binaries sometimes fail to install. This script runs after `npm install`
// to detect and fix that.

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const toInstall = [];

// Check @lydell/node-pty native binary
const ptyPlatformPkg = `@lydell/node-pty-${process.platform}-${process.arch}`;
try {
  require.resolve(`${ptyPlatformPkg}/conpty.node`);
} catch {
  try {
    // Get the version that @lydell/node-pty expects
    const ptyPkg = require('@lydell/node-pty/package.json');
    const version = ptyPkg.optionalDependencies?.[ptyPlatformPkg];
    if (version) {
      toInstall.push(`${ptyPlatformPkg}@${version}`);
    }
  } catch {
    // @lydell/node-pty itself not installed yet, skip
  }
}

// Check rollup native binary
try {
  require.resolve('rollup/dist/native.js');
  // If it resolves, try actually loading it to see if the native module works
  require('rollup/dist/native.js');
} catch (e) {
  if (e.message && e.message.includes('rollup')) {
    try {
      const rollupPkg = require('rollup/package.json');
      const optDeps = rollupPkg.optionalDependencies || {};
      // Find the matching native package for this platform+arch
      // On Windows, prefer msvc over gnu
      const candidates = Object.keys(optDeps).filter(k =>
        k.startsWith('@rollup/rollup-') &&
        k.includes(process.platform) &&
        k.includes(process.arch)
      );
      const match = candidates.find(k => k.includes('msvc')) || candidates[0];
      if (match) {
        toInstall.push(`${match}@${optDeps[match]}`);
      }
    } catch {
      // rollup itself not installed yet, skip
    }
  }
}

// If mob hooks are already installed, update them to pick up any script changes
updateMobHooksIfInstalled();

if (toInstall.length > 0) {
  console.log(`\nInstalling missing native dependencies: ${toInstall.join(', ')}`);
  try {
    execSync(`npm install --no-save ${toInstall.join(' ')}`, {
      stdio: 'inherit',
      env: { ...process.env, npm_config_ignore_scripts: 'true' },
    });
    console.log('Native dependencies installed successfully.\n');
  } catch (err) {
    console.error('\nFailed to auto-install native dependencies.');
    console.error('Try manually: npm install ' + toInstall.join(' '));
    console.error('');
  }
}

function updateMobHooksIfInstalled() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (!settings.hooks) return;

    const hookScript = path.resolve(__dirname, '..', 'hooks', 'mob-status.sh');
    const hookScriptWin = path.resolve(__dirname, '..', 'hooks', 'mob-status.ps1');
    const newCommand = process.platform === 'win32'
      ? `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')}" -NoProfile -ExecutionPolicy Bypass -File "${hookScriptWin}"`
      : `bash "${hookScript}" || true`;

    let updated = false;
    for (const event of Object.keys(settings.hooks)) {
      const entries = settings.hooks[event];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry.hooks || !Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
          if (hook.type === 'command' && typeof hook.command === 'string' && hook.command.includes('mob-status')) {
            if (hook.command !== newCommand) {
              hook.command = newCommand;
              updated = true;
            }
          }
        }
      }
    }

    if (updated) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log('Mob hooks updated in ~/.claude/settings.json');
    }
  } catch {
    // Best-effort — don't fail the install if hook update fails
  }
}
