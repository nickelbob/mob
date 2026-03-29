import * as pty from '@lydell/node-pty';
import os from 'os';
import { EventEmitter } from 'events';
import treeKill from 'tree-kill';
import { getDefaultShell, getShellArgs } from './util/platform.js';
import { shellQuote, isValidModel, isValidPermissionMode, isValidSessionId } from './util/sanitize.js';
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
  // Strip trailing slash (node-pty can choke on it)
  if (resolved.length > 1 && resolved.endsWith('/')) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

const log = createLogger('pty');

// Prompt patterns that indicate the shell is ready for command input
const SHELL_PROMPT_RE = /[$%#>]\s*$/;
const SHELL_READY_TIMEOUT_MS = 5000;

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

    // Build claude command with validated & shell-quoted arguments
    let cmd = 'claude';
    if (opts?.claudeSessionId && isValidSessionId(opts.claudeSessionId)) {
      cmd += ` --resume ${shellQuote(opts.claudeSessionId)}`;
    } else if (opts?.resume) {
      cmd += ' --continue';
    }
    if (!opts?.claudeSessionId && !opts?.resume) {
      cmd += ` --name ${shellQuote('mob-' + instanceId)}`;
    }
    if (opts?.model && isValidModel(opts.model)) {
      cmd += ` --model ${shellQuote(opts.model)}`;
    }
    if (opts?.permissionMode && isValidPermissionMode(opts.permissionMode)) {
      cmd += ` --permission-mode ${shellQuote(opts.permissionMode)}`;
    }

    // Wait for shell prompt before injecting command (with timeout fallback)
    let shellReady = false;
    let outputBuffer = '';
    const timeoutId = setTimeout(() => {
      if (!shellReady) {
        shellReady = true;
        log.warn(`Shell readiness timeout for id=${instanceId}, injecting command anyway`);
        if (opts?.setupCommands?.length) {
          for (const setupCmd of opts.setupCommands) {
            p.write(setupCmd + '\r');
          }
        }
        p.write(cmd + '\r');
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
        // Run setup commands before the claude command
        if (opts?.setupCommands?.length) {
          for (const setupCmd of opts.setupCommands) {
            log.info(`Running setup command for id=${instanceId}: ${setupCmd}`);
            p.write(setupCmd + '\r');
          }
        }
        p.write(cmd + '\r');
      }
    };

    p.onData((data) => {
      readinessHandler(data);
      this.emit('data', instanceId, data);
    });

    p.onExit(({ exitCode }) => {
      log.info(`PTY exited: id=${instanceId} code=${exitCode}`);
      clearTimeout(timeoutId);
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
