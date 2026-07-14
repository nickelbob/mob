import express from 'express';
import { execFile } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import type { InstanceManager } from './instance-manager.js';
import type { SettingsManager } from './settings-manager.js';
import { validateHookPayload, isPathWithinHome } from './util/sanitize.js';
import { buildOAuthAuthorizeUrl, exchangeOAuthCode, fetchCloudId } from './jira-client.js';
import { createLogger } from './util/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('http');

/**
 * DNS-rebinding guard. A malicious page can point its own domain at
 * 127.0.0.1 and then issue same-origin requests to this server — the Host
 * header is the attacker's domain. Legitimate localhost access always uses
 * `localhost` or an IP literal, so reject domain names.
 */
function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.split(':')[0];
  return hostname === 'localhost' || net.isIP(hostname) !== 0;
}

/**
 * The guard only makes sense for the default loopback binding. Setting
 * MOB_HOST to a non-loopback address is an explicit opt-in to network
 * exposure (see README "Security Model") where clients legitimately use
 * arbitrary DNS names (mDNS, Tailscale, …) — rebinding protection is
 * meaningless there, so don't break it.
 */
function shouldEnforceHostCheck(): boolean {
  const bind = process.env.MOB_HOST;
  return !bind || bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
}

export function createApp(instanceManager: InstanceManager, settingsManager: SettingsManager): express.Application {
  const app = express();
  app.use(express.json());

  const enforceHostCheck = shouldEnforceHostCheck();
  app.use((req, res, next) => {
    if (enforceHostCheck && !isAllowedHost(req.headers.host)) {
      log.warn(`Rejected request with disallowed Host header: ${req.headers.host}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  });

  // Request logging for API routes
  app.use('/api', (req, _res, next) => {
    log.info(`→ ${req.method} ${req.originalUrl}`);
    next();
  });

  // Serve static frontend in production (only if built)
  const clientDir = path.join(__dirname, '..', '..', 'client');
  const indexHtml = path.join(clientDir, 'index.html');
  const hasBuiltClient = fs.existsSync(indexHtml);

  if (hasBuiltClient) {
    app.use(express.static(clientDir));
  }

  // Directory autocomplete for launch dialog
  app.get('/api/completions/dirs', (req, res) => {
    const partial = (req.query.q as string) || '';
    if (!partial) {
      res.json([]);
      return;
    }

    // Expand ~ to home dir
    const home = os.homedir();
    let expanded = partial.startsWith('~')
      ? path.join(home, partial.slice(1))
      : partial;

    // Convert MSYS/Git Bash paths (/e/Development → E:\Development)
    if (process.platform === 'win32') {
      const msysMatch = expanded.match(/^\/([a-zA-Z])(\/.*)?$/);
      if (msysMatch) {
        expanded = msysMatch[1].toUpperCase() + ':' + (msysMatch[2] || '\\').replace(/\//g, '\\');
      }
    }

    const endsWithSep = expanded.endsWith('/') || expanded.endsWith('\\');
    const dir = endsWithSep ? expanded : path.dirname(expanded);
    const prefix = endsWithSep ? '' : path.basename(expanded);

    const resolvedDir = path.resolve(dir);

    // Confine autocomplete to the user's home directory — this endpoint
    // would otherwise enumerate arbitrary filesystem structure.
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
          const display = full.startsWith(home) ? '~' + full.slice(home.length).replace(/\\/g, '/') : full.replace(/\\/g, '/');
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

  // Open a directory in the native file explorer
  app.post('/api/open-dir', (req, res) => {
    const dir = req.body?.path as string;
    if (!dir || typeof dir !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }
    if (dir.includes('\0') || dir.includes('\n') || dir.includes('\r')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    // Verify the directory belongs to a known instance to prevent arbitrary path opening
    const allowed = instanceManager.getAll().some(i => i.cwd === dir);
    if (!allowed) {
      res.status(403).json({ error: 'Path not associated with any instance' });
      return;
    }

    const cmd = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open'
      : 'xdg-open';
    execFile(cmd, [dir], { timeout: 5000 } as any, (err: any) => {
      // explorer.exe returns non-zero exit codes even on success — ignore
      if (err && process.platform !== 'win32') {
        log.error('open-dir failed:', err.message);
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ ok: true });
    });
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

  // JIRA OAuth flow
  let oauthState: string | null = null;

  app.get('/api/jira/auth', (req, res) => {
    const settings = settingsManager.get();
    const clientId = settings.jira.oauthClientId;
    if (!clientId) {
      res.status(400).json({ error: 'OAuth Client ID not configured. Set it in Settings > JIRA.' });
      return;
    }
    oauthState = crypto.randomBytes(16).toString('hex');
    const port = req.socket.localPort || 4040;
    const redirectUri = `http://localhost:${port}/api/jira/callback`;
    const url = buildOAuthAuthorizeUrl(clientId, redirectUri, oauthState);
    res.json({ url });
  });

  app.get('/api/jira/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      res.status(400).send(`<h2>JIRA Authorization Failed</h2><p>${error}</p><script>window.close()</script>`);
      return;
    }
    if (!code || state !== oauthState) {
      res.status(400).send('<h2>Invalid callback</h2><p>State mismatch or missing code.</p>');
      return;
    }
    oauthState = null;

    const settings = settingsManager.get();
    const port = req.socket.localPort || 4040;
    const redirectUri = `http://localhost:${port}/api/jira/callback`;

    const tokens = await exchangeOAuthCode(
      settings.jira.oauthClientId,
      settings.jira.oauthClientSecret,
      code as string,
      redirectUri,
    );
    if (!tokens) {
      res.status(500).send('<h2>Token exchange failed</h2><p>Check server logs.</p>');
      return;
    }

    // Fetch cloud ID and site URL
    const site = await fetchCloudId(tokens.accessToken);
    if (!site) {
      res.status(500).send('<h2>Failed to fetch Atlassian site info</h2><p>Check server logs.</p>');
      return;
    }

    // Save tokens and site info
    settingsManager.update({
      jira: {
        oauthAccessToken: tokens.accessToken,
        oauthRefreshToken: tokens.refreshToken,
        oauthTokenExpiry: Date.now() + tokens.expiresIn * 1000,
        cloudId: site.cloudId,
        baseUrl: site.baseUrl,
      },
    });
    instanceManager.refreshTicketFields();

    log.info(`JIRA OAuth connected: site=${site.baseUrl} cloudId=${site.cloudId}`);
    res.send('<h2>Connected to JIRA!</h2><p>You can close this window.</p><script>window.close()</script>');
  });

  app.post('/api/jira/disconnect', (_req, res) => {
    settingsManager.update({
      jira: {
        oauthAccessToken: '',
        oauthRefreshToken: '',
        oauthTokenExpiry: 0,
        cloudId: '',
      },
    });
    res.json({ ok: true });
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

  // REST: edit instance (name, project, model, permissionMode)
  app.patch('/api/instances/:id', (req, res) => {
    const fields: Record<string, string> = {};
    for (const key of ['name', 'project', 'model', 'permissionMode']) {
      if (typeof req.body[key] === 'string') fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) {
      res.status(400).json({ error: 'No valid fields provided' });
      return;
    }
    const ok = instanceManager.editInstance(req.params.id, fields);
    if (!ok) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    res.json(instanceManager.get(req.params.id));
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
