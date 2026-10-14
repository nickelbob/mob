import fs from 'fs';
import path from 'path';
import { getSessionsDir, getScrollbackDir, getGitBranch, getGitRoot, getGitRemoteUrl } from './util/platform.js';
import { SESSION_MAX_AGE_MS } from '../shared/constants.js';
import type { InstanceInfo } from '../shared/protocol.js';
import { createLogger } from './util/logger.js';

const log = createLogger('session-store');

export interface SessionData {
  id: string;
  name: string;
  cwd: string;
  /** Absent in files written before external-session persistence → treated as true. */
  managed?: boolean;
  project?: string;
  gitBranch?: string;
  model?: string;
  permissionMode?: string;
  claudeSessionId?: string;
  previousInstanceId?: string;
  createdAt: number;
  /** Last hook/terminal activity — expiry keys on this, not createdAt, so a
   *  long-lived session that never stopped cleanly isn't pruned by age. */
  lastActivityAt?: number;
  stoppedAt?: number;
  ticket?: string;
  subtask?: string;
  autoResume?: boolean;
}

export function lastActiveOf(
  data: Pick<SessionData, 'createdAt' | 'lastActivityAt' | 'stoppedAt'>
): number {
  return data.stoppedAt ?? data.lastActivityAt ?? data.createdAt;
}

export function isExpired(
  data: Pick<SessionData, 'id' | 'createdAt' | 'lastActivityAt' | 'stoppedAt'>,
  now: number,
  isAlive?: (id: string) => boolean
): boolean {
  if (isAlive?.(data.id)) return false;
  return lastActiveOf(data) < now - SESSION_MAX_AGE_MS;
}

export class SessionStore {
  save(instance: InstanceInfo, opts?: { autoResume?: boolean }): void {
    const data: SessionData = {
      id: instance.id,
      name: instance.name,
      cwd: instance.cwd,
      managed: instance.managed,
      project: instance.project,
      gitBranch: instance.gitBranch,
      model: instance.model,
      permissionMode: instance.permissionMode,
      claudeSessionId: instance.claudeSessionId,
      previousInstanceId: instance.previousInstanceId,
      createdAt: instance.createdAt || Date.now(),
      lastActivityAt: instance.lastUpdated || Date.now(),
      stoppedAt: instance.stoppedAt,
      ticket: instance.ticket,
      subtask: instance.subtask,
      autoResume: opts?.autoResume,
    };
    const filePath = path.join(getSessionsDir(), `${instance.id}.json`);
    const tmpPath = filePath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      log.error(`Failed to save session ${instance.id}:`, err);
      try { fs.unlinkSync(tmpPath); } catch { /* ok */ }
    }
  }

  loadAll(isAlive?: (id: string) => boolean): (InstanceInfo & { autoResume?: boolean })[] {
    const dir = getSessionsDir();
    const now = Date.now();
    const instances: (InstanceInfo & { autoResume?: boolean })[] = [];

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const raw = fs.readFileSync(filePath, 'utf8');
        const data: SessionData = JSON.parse(raw);

        if (isExpired(data, now, isAlive)) {
          this.removeFiles(data.id);
          continue;
        }

        instances.push({
          id: data.id,
          name: data.name,
          managed: data.managed ?? true,
          cwd: data.cwd,
          project: data.project,
          gitRoot: getGitRoot(data.cwd),
          gitRemoteUrl: getGitRemoteUrl(data.cwd),
          gitBranch: getGitBranch(data.cwd) || data.gitBranch,
          state: 'stopped',
          lastUpdated: lastActiveOf(data),
          model: data.model,
          permissionMode: data.permissionMode,
          claudeSessionId: data.claudeSessionId,
          previousInstanceId: data.previousInstanceId,
          createdAt: data.createdAt,
          stoppedAt: data.stoppedAt,
          historical: true,
          ticket: data.ticket,
          subtask: data.subtask,
          autoResume: data.autoResume,
        });
      } catch (err) {
        log.error(`Failed to load session from ${file}:`, err);
      }
    }

    log.info(`Loaded ${instances.length} previous session(s)`);
    return instances;
  }

  pruneExpired(isAlive?: (id: string) => boolean): void {
    const dir = getSessionsDir();
    const now = Date.now();
    let pruned = 0;

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      return;
    }

    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const raw = fs.readFileSync(filePath, 'utf8');
        const data: SessionData = JSON.parse(raw);
        if (isExpired(data, now, isAlive)) {
          this.removeFiles(data.id);
          pruned++;
        }
      } catch {
        // Skip malformed files
      }
    }

    if (pruned > 0) log.info(`Pruned ${pruned} expired session(s)`);
  }

  remove(instanceId: string): void {
    this.removeFiles(instanceId);
  }

  private removeFiles(instanceId: string): void {
    const sessionPath = path.join(getSessionsDir(), `${instanceId}.json`);
    const scrollbackPath = path.join(getScrollbackDir(), `${instanceId}.log`);
    try { fs.unlinkSync(sessionPath); } catch { /* ok */ }
    try { fs.unlinkSync(scrollbackPath); } catch { /* ok */ }
  }
}
