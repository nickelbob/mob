import * as pty from '@lydell/node-pty';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import treeKill from 'tree-kill';
import { getDefaultShell, getShellArgs } from './util/platform.js';
import { isValidModel, isValidPermissionMode, isValidSessionId } from './util/sanitize.js';
import { createLogger } from './util/logger.js';
import type { IPty } from '@lydell/node-pty';

export interface PtyHandle {
  pty: IPty;
  instanceId: string;
}

function expandHome(p: string): string {
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
  // Strip trailing slash (node-pty can choke on it)
  if (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

const log = createLogger('pty');

// Prompt patterns that indicate the shell is ready for command input
const SHELL_PROMPT_RE = /[$%#>]\s*$/;
const SHELL_READY_TIMEOUT_MS = 5000;

// Error patterns that indicate claude --continue or --resume failed
const RESUME_ERROR_RE = /Error:.*(?:No (?:conversation|deferred)|not a UUID|does not match|session.*not found|No matching|Could not find)/i;
// How long to watch for resume errors after injecting the command
const RESUME_ERROR_WATCH_MS = 10000;

/**
 * Encode a cwd path to the Claude projects directory name.
 * E.g. "E:\Development\mob" → "E--Development-mob"
 */
function encodeCwdToProjectDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  return resolved.replace(/[:\\/]/g, '-');
}

/**
 * Find the latest session ID for a given working directory by scanning
 * ~/.claude/projects/<encoded-path>/*.jsonl
 */
function findLatestSession(cwd: string): string | null {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeCwdToProjectDir(cwd));
  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && /^[0-9a-f]{8}-/.test(f));
    if (files.length === 0) return null;

    let latestFile = '';
    let latestMtime = 0;
    for (const f of files) {
      const stat = fs.statSync(path.join(projectDir, f));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = f;
      }
    }
    return latestFile ? latestFile.replace('.jsonl', '') : null;
  } catch {
    return null;
  }
}

export class PtyManager extends EventEmitter {
  private ptys = new Map<string, IPty>();

  spawn(instanceId: string, cwd: string, opts?: {
    model?: string;
    permissionMode?: string;
    claudeSessionId?: string;
    resume?: boolean;
    setupCommands?: string[];
  }): IPty {
    const shell = getDefaultShell();
    const args = getShellArgs(shell);
    const resolvedCwd = expandHome(cwd);

    log.info(`Spawning: shell=${shell} cwd=${resolvedCwd} id=${instanceId}`);

    let p: IPty;
    try {
      p = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: resolvedCwd,
        env: {
          ...process.env,
          MOB_INSTANCE_ID: instanceId,
          TERM: 'xterm-256color',
        } as Record<string, string>,
      });
    } catch (err) {
      log.error(`Failed to spawn PTY:`, err);
      this.emit('error', instanceId, err);
      throw err;
    }

    log.info(`PTY spawned: pid=${p.pid}`);
    this.ptys.set(instanceId, p);

    // Build claude command. All interpolated values are validated against strict
    // allowlists (see sanitize.ts), so they contain no shell metacharacters and
    // don't need quoting — which matters on Windows cmd.exe, where POSIX-style
    // single quotes would be passed to claude literally.
    let baseFlags = '';
    if (opts?.model && isValidModel(opts.model)) {
      baseFlags += ` --model ${opts.model}`;
    }
    if (opts?.permissionMode && isValidPermissionMode(opts.permissionMode)) {
      baseFlags += ` --permission-mode ${opts.permissionMode}`;
    }

    const isResuming = !!(opts?.claudeSessionId || opts?.resume);
    let cmd = 'claude';
    if (opts?.claudeSessionId && isValidSessionId(opts.claudeSessionId)) {
      cmd += ` --resume ${opts.claudeSessionId}`;
    } else if (opts?.resume) {
      cmd += ' --continue';
    }
    if (!isResuming) {
      cmd += ` --name mob-${instanceId}`;
    }
    cmd += baseFlags;

    // Wait for shell prompt before injecting command (with timeout fallback)
    let shellReady = false;
    let outputBuffer = '';

    const injectCommand = (command: string) => {
      if (opts?.setupCommands?.length) {
        for (const setupCmd of opts.setupCommands) {
          log.info(`Running setup command for id=${instanceId}: ${setupCmd}`);
          p.write(setupCmd + '\r');
        }
      }
      p.write(command + '\r');
    };

    const timeoutId = setTimeout(() => {
      if (!shellReady) {
        shellReady = true;
        log.warn(`Shell readiness timeout for id=${instanceId}, injecting command anyway`);
        injectCommand(cmd);
      }
    }, SHELL_READY_TIMEOUT_MS);

    const readinessHandler = (data: string) => {
      if (shellReady) return;
      outputBuffer += data;
      // Check the last portion for a prompt character
      const tail = outputBuffer.slice(-200);
      if (SHELL_PROMPT_RE.test(tail)) {
        shellReady = true;
        clearTimeout(timeoutId);
        log.info(`Shell ready for id=${instanceId}, injecting command`);
        injectCommand(cmd);
      }
    };

    // Resume failure detection: watch for error output after command injection
    // and retry with fallback commands
    let resumeRetryState: 'watching' | 'retrying-latest' | 'done' = isResuming ? 'watching' : 'done';
    let postCommandBuffer = '';
    let resumeWatchTimeout: ReturnType<typeof setTimeout> | null = null;

    if (isResuming) {
      resumeWatchTimeout = setTimeout(() => {
        resumeRetryState = 'done';
      }, RESUME_ERROR_WATCH_MS);
    }

    const resumeErrorHandler = (data: string) => {
      if (resumeRetryState === 'done') return;
      if (!shellReady) return; // command hasn't been sent yet

      postCommandBuffer += data;
      const chunk = postCommandBuffer.slice(-1000);

      if (!RESUME_ERROR_RE.test(chunk)) return;

      if (resumeRetryState === 'watching') {
        // First failure: try finding the latest session for this directory
        const latestSessionId = findLatestSession(cwd);
        if (latestSessionId && latestSessionId !== opts?.claudeSessionId) {
          log.warn(`Resume failed for id=${instanceId}, retrying with latest session ${latestSessionId}`);
          resumeRetryState = 'retrying-latest';
          postCommandBuffer = '';
          p.write(`claude --resume ${latestSessionId}${baseFlags}\r`);
        } else {
          // No session found or same session — go straight to fresh start
          log.warn(`Resume failed for id=${instanceId}, no alternative session found — starting fresh`);
          if (resumeWatchTimeout) clearTimeout(resumeWatchTimeout);
          resumeRetryState = 'done';
          p.write(`claude --name mob-${instanceId}${baseFlags}\r`);
        }
      } else if (resumeRetryState === 'retrying-latest') {
        // Latest session also failed — start fresh
        log.warn(`Resume with latest session also failed for id=${instanceId} — starting fresh`);
        if (resumeWatchTimeout) clearTimeout(resumeWatchTimeout);
        resumeRetryState = 'done';
        p.write(`claude --name mob-${instanceId}${baseFlags}\r`);
      }
    };

    p.onData((data) => {
      readinessHandler(data);
      resumeErrorHandler(data);
      this.emit('data', instanceId, data);
    });

    p.onExit(({ exitCode }) => {
      log.info(`PTY exited: id=${instanceId} code=${exitCode}`);
      clearTimeout(timeoutId);
      if (resumeWatchTimeout) clearTimeout(resumeWatchTimeout);
      this.ptys.delete(instanceId);
      this.emit('exit', instanceId, exitCode);
    });

    return p;
  }

  write(instanceId: string, data: string): void {
    this.ptys.get(instanceId)?.write(data);
  }

  resize(instanceId: string, cols: number, rows: number): void {
    this.ptys.get(instanceId)?.resize(cols, rows);
  }

  kill(instanceId: string): void {
    const p = this.ptys.get(instanceId);
    if (p) {
      const pid = p.pid;
      log.info(`Killing PTY: id=${instanceId} pid=${pid}`);
      this.ptys.delete(instanceId);

      // Use tree-kill to terminate the entire process tree (shell + claude + children)
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) {
          log.warn(`tree-kill SIGTERM failed for pid=${pid}, trying SIGKILL:`, err.message);
          // Fallback: force kill after 3 seconds
          setTimeout(() => {
            treeKill(pid, 'SIGKILL', () => {});
          }, 3000);
        }
      });
    }
  }

  has(instanceId: string): boolean {
    return this.ptys.has(instanceId);
  }

  getAll(): Map<string, IPty> {
    return this.ptys;
  }
}
