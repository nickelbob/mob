import * as pty from '@lydell/node-pty';
import os from 'os';
import { EventEmitter } from 'events';
import { getDefaultShell, getShellArgs } from './util/platform.js';
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

function log(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [pty]`, ...args);
}

export class PtyManager extends EventEmitter {
  private ptys = new Map<string, IPty>();

  spawn(instanceId: string, cwd: string, opts?: {
    model?: string;
    permissionMode?: string;
    claudeSessionId?: string;
    resume?: boolean;
  }): IPty {
    const shell = getDefaultShell();
    const args = getShellArgs(shell);
    const resolvedCwd = expandHome(cwd);

    log(`Spawning: shell=${shell} cwd=${resolvedCwd} id=${instanceId}`);

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
      log(`Failed to spawn PTY:`, err);
      this.emit('error', instanceId, err);
      throw err;
    }

    log(`PTY spawned: pid=${p.pid}`);
    this.ptys.set(instanceId, p);

    p.onData((data) => {
      this.emit('data', instanceId, data);
    });

    p.onExit(({ exitCode }) => {
      log(`PTY exited: id=${instanceId} code=${exitCode}`);
      this.ptys.delete(instanceId);
      this.emit('exit', instanceId, exitCode);
    });

    // Build claude command
    setTimeout(() => {
      let cmd = 'claude';
      if (opts?.claudeSessionId) {
        cmd += ` --resume ${opts.claudeSessionId}`;
      } else if (opts?.resume) {
        cmd += ' --continue';
      }
      if (!opts?.claudeSessionId && !opts?.resume) {
        cmd += ` --name mob-${instanceId}`;
      }
      if (opts?.model) cmd += ` --model ${opts.model}`;
      if (opts?.permissionMode) cmd += ` --permission-mode ${opts.permissionMode}`;
      log(`Sending command: ${cmd}`);
      p.write(cmd + '\r');
    }, 500);

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
      log(`Killing PTY: id=${instanceId} pid=${p.pid}`);
      p.kill();
      this.ptys.delete(instanceId);
    }
  }

  has(instanceId: string): boolean {
    return this.ptys.has(instanceId);
  }

  getAll(): Map<string, IPty> {
    return this.ptys;
  }
}
