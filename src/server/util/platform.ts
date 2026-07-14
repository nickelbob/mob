import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFile, execFileSync } from 'child_process';

export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

export function getShellArgs(shell: string): string[] {
  if (shell.includes('powershell') || shell.includes('pwsh')) {
    return ['-NoLogo'];
  }
  return [];
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function getMobDir(): string {
  return path.join(os.homedir(), '.mob');
}

export function getInstancesDir(): string {
  return path.join(getMobDir(), 'instances');
}

export function getSessionsDir(): string {
  return path.join(getMobDir(), 'sessions');
}

export function getScrollbackDir(): string {
  return path.join(getMobDir(), 'scrollback');
}

/** Resolve ~, MSYS paths, and normalize a path for comparison. */
export function resolvePath(p: string): string {
  let resolved = p;
  if (resolved.startsWith('~/') || resolved === '~') {
    resolved = os.homedir() + resolved.slice(1);
  }
  // Convert MSYS/Git Bash paths (/e/Development → E:\Development)
  if (process.platform === 'win32') {
    const msysMatch = resolved.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (msysMatch) {
      resolved = msysMatch[1].toUpperCase() + ':' + (msysMatch[2] || '\\').replace(/\//g, '\\');
    }
  }
  return path.resolve(resolved);
}

function expandHome(cwd: string): string {
  if (cwd.startsWith('~/') || cwd === '~') {
    return os.homedir() + cwd.slice(1);
  }
  return cwd;
}

function gitSync(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: expandHome(cwd),
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitAsync(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: expandHome(cwd),
      encoding: 'utf-8',
      timeout: 3000,
    }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}

// Remote URL and repo root never change for a given cwd during a server's
// lifetime — cache successful lookups so hook updates and launches don't
// repeatedly block the event loop on git subprocesses. Failures aren't
// cached (a directory can become a repo later).
const gitRemoteUrlCache = new Map<string, string>();
const gitRootCache = new Map<string, string>();

export function getGitRemoteUrl(cwd: string): string | undefined {
  const cached = gitRemoteUrlCache.get(cwd);
  if (cached !== undefined) return cached;
  const value = gitSync(cwd, ['remote', 'get-url', 'origin']);
  if (value !== undefined) gitRemoteUrlCache.set(cwd, value);
  return value;
}

export function getGitRoot(cwd: string): string | undefined {
  const cached = gitRootCache.get(cwd);
  if (cached !== undefined) return cached;
  const value = gitSync(cwd, ['rev-parse', '--show-toplevel']);
  if (value !== undefined) gitRootCache.set(cwd, value);
  return value;
}

export function getGitBranch(cwd: string): string | undefined {
  return gitSync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** Async branch lookup for periodic refresh — never blocks the event loop. */
export function getGitBranchAsync(cwd: string): Promise<string | undefined> {
  return gitAsync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}
