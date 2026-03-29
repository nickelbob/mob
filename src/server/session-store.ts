import fs from 'fs';
import path from 'path';
import { getSessionsDir, getScrollbackDir, getGitBranch } from './util/platform.js';
import { SESSION_MAX_AGE_MS } from '../shared/constants.js';
import type { InstanceInfo } from '../shared/protocol.js';
import { createLogger } from './util/logger.js';

const log = createLogger('session-store');

export interface SessionData {
  id: string;
  name: string;
  cwd: string;
  gitBranch?: string;
  model?: string;
  permissionMode?: string;
  claudeSessionId?: string;
  previousInstanceId?: string;
  createdAt: number;
  stoppedAt?: number;
  ticket?: string;
  subtask?: string;
  autoResume?: boolean;
}

export class SessionStore {
  save(instance: InstanceInfo, opts?: { autoResume?: boolean }): void {
    const data: SessionData = {
      id: instance.id,
      name: instance.name,
      cwd: instance.cwd,
      gitBranch: instance.gitBranch,
      model: instance.model,
      permissionMode: instance.permissionMode,
      claudeSessionId: instance.claudeSessionId,
      previousInstanceId: instance.previousInstanceId,
      createdAt: instance.createdAt || Date.now(),
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

  loadAll(): (InstanceInfo & { autoResume?: boolean })[] {
    const dir = getSessionsDir();
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
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

        // Skip expired sessions
        const lastActive = data.stoppedAt || data.createdAt;
        if (lastActive < cutoff) {
          this.removeFiles(data.id);
          continue;
        }

        instances.push({
          id: data.id,
          name: data.name,
          managed: true,
          cwd: data.cwd,
          gitBranch: getGitBranch(data.cwd) || data.gitBranch,
          state: 'stopped',
          lastUpdated: data.stoppedAt || data.createdAt,
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

  pruneExpired(): void {
    const dir = getSessionsDir();
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
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
        const lastActive = data.stoppedAt || data.createdAt;
        if (lastActive < cutoff) {
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
