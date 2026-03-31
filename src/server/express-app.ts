import express from 'express';
import { exec, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { InstanceManager } from './instance-manager.js';
import type { SettingsManager } from './settings-manager.js';
import { isPathWithinHome, shellQuote, validateHookPayload } from './util/sanitize.js';
import { createLogger } from './util/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('http');

export function createApp(instanceManager: InstanceManager, settingsManager: SettingsManager): express.Application {
  const app = express();
  app.use(express.json());

  // Request logging for API routes
  app.use('/api', (req, _res, next) => {
    log.info(`${req.method} ${req.originalUrl}`);
    next();
  });

  // Serve static frontend in production (only if built)
  const clientDir = path.join(__dirname, '..', '..', 'client');
  const indexHtml = path.join(clientDir, 'index.html');
  const hasBuiltClient = fs.existsSync(indexHtml);

  if (hasBuiltClient) {
    app.use(express.static(clientDir));
  }

  // Directory autocomplete for launch dialog (restricted to home directory)
  app.get('/api/completions/dirs', (req, res) => {
    const partial = (req.query.q as string) || '';
    if (!partial) {
      res.json([]);
      return;
    }

    // Expand ~ to home dir
    const home = os.homedir();
    const expanded = partial.startsWith('~')
      ? path.join(home, partial.slice(1))
      : partial;

    // Restrict to home directory tree
    const resolved = path.resolve(expanded);
    if (!isPathWithinHome(resolved)) {
      res.json([]);
      return;
    }

    const dir = expanded.endsWith('/') ? expanded : path.dirname(expanded);
    const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);

    // Verify dir is also within home
    const resolvedDir = path.resolve(dir);
    if (!isPathWithinHome(resolvedDir)) {
      res.json([]);
      return;
    }

    try {
      const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
      const matches = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix.toLowerCase()))
        .slice(0, 20)
        .map((e) => {
          const full = path.join(resolvedDir, e.name);
          const display = full.startsWith(home) ? '~' + full.slice(home.length) : full;
          return { path: full, display: display + '/' };
        });
      res.json(matches);
    } catch {
      res.json([]);
    }
  });

  // Browse for directory — opens native folder picker
  app.post('/api/browse-dir', (req, res) => {
    const startDir = (req.body?.startDir as string) || process.env.HOME || 'C:\\';
    const expanded = startDir.startsWith('~')
      ? path.join(process.env.HOME || 'C:\\', startDir.slice(1))
      : startDir;

    // Validate path has no null bytes or newlines
    if (expanded.includes('\0') || expanded.includes('\n') || expanded.includes('\r')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    log.info('browse-dir requested, startDir:', expanded);

    if (process.platform === 'win32') {
      const psPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'browse-dir.ps1');
      execFile(psPath, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-StartPath', expanded], { timeout: 60000, windowsHide: false } as any, (err: any, stdout: string, stderr: string) => {
        if (err) {
          log.error('browse-dir error:', err.message, stderr);
          res.json({ cancelled: true });
          return;
        }
        const selected = stdout.trim();
        log.info('browse-dir result:', selected || '(cancelled)');
        if (selected) {
          res.json({ path: selected });
        } else {
          res.json({ cancelled: true });
        }
      });
    } else if (process.platform === 'darwin') {
      // Shell-quote the path within the AppleScript string to prevent injection
      const escapedPath = expanded.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      execFile('osascript', ['-e', `choose folder with prompt "Select working directory" default location POSIX file "${escapedPath}"`], { timeout: 60000 }, (err, stdout) => {
        if (err) { res.json({ cancelled: true }); return; }
        const alias = stdout.trim();
        const posix = alias.replace(/^alias [^:]+:/, '/').replace(/:/g, '/');
        res.json({ path: posix });
      });
    } else {
      execFile('zenity', ['--file-selection', '--directory', `--filename=${expanded}/`], { timeout: 60000 }, (err, stdout) => {
        if (err) { res.json({ cancelled: true }); return; }
        res.json({ path: stdout.trim() });
      });
    }
  });

  // Platform info for client feature detection
  app.get('/api/platform', (_req, res) => {
    res.json({ platform: process.platform });
  });

  // Settings API
  app.get('/api/settings', (_req, res) => {
    res.json(settingsManager.getRedacted());
  });

  app.put('/api/settings', (req, res) => {
    try {
      settingsManager.update(req.body);
      instanceManager.refreshTicketFields();
      res.json(settingsManager.getRedacted());
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Invalid settings' });
    }
  });

  // Hook endpoint — receives status updates from hook scripts
  app.post('/api/hook', (req, res) => {
    const result = validateHookPayload(req.body);
    if (!result.valid) {
      res.status(400).json({ error: result.error });
      return;
    }
    const data = result.data;
    log.info(`hook update: id=${data.id} state=${data.state} topic=${(data.topic as string) || '(none)'}`);
    data.lastUpdated = data.lastUpdated || Date.now();
    instanceManager.handleHookUpdate(data as any);
    res.json({ ok: true });
  });

  // REST: list instances
  app.get('/api/instances', (_req, res) => {
    res.json(instanceManager.getAll());
  });

  // REST: get single instance
  app.get('/api/instances/:id', (req, res) => {
    const info = instanceManager.get(req.params.id);
    if (!info) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(info);
  });

  // Fallback to index.html for SPA routing (production only)
  if (hasBuiltClient) {
    app.get('*', (_req, res) => {
      res.sendFile(indexHtml);
    });
  }

  // Global error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error('Unhandled route error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
