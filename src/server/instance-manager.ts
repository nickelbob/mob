import { EventEmitter } from 'events';
import { PtyManager } from './pty-manager.js';
import { DiscoveryService } from './discovery.js';
import { SessionStore } from './session-store.js';
import { ScrollbackBuffer } from './scrollback-buffer.js';
import type { InstanceInfo, InstanceState, LaunchPayload } from '../shared/protocol.js';
import type { InstanceStatusFile } from './types.js';
import { generateInstanceId } from './util/id.js';
import { STALE_THRESHOLD_MS } from '../shared/constants.js';
import { getGitBranch } from './util/platform.js';

export class InstanceManager extends EventEmitter {
  private instances = new Map<string, InstanceInfo>();
  private managedIds = new Set<string>();
  private autoNameIds = new Set<string>();
  private ptyManager: PtyManager;
  private discovery: DiscoveryService;
  private sessionStore: SessionStore;
  private scrollbackBuffer: ScrollbackBuffer;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  public subscribers = new Map<string, Set<import('ws').WebSocket>>();

  constructor(
    ptyManager: PtyManager,
    discovery: DiscoveryService,
    sessionStore: SessionStore,
    scrollbackBuffer: ScrollbackBuffer,
  ) {
    super();
    this.ptyManager = ptyManager;
    this.discovery = discovery;
    this.sessionStore = sessionStore;
    this.scrollbackBuffer = scrollbackBuffer;
    this.setupListeners();
    this.loadPreviousSessions();
  }

  private loadPreviousSessions(): void {
    const sessions = this.sessionStore.loadAll();
    const toResume: typeof sessions = [];
    for (const info of sessions) {
      this.instances.set(info.id, info);
      this.managedIds.add(info.id);
      if (info.autoResume) {
        toResume.push(info);
      }
    }
    // Auto-resume instances that were running when the server shut down
    if (toResume.length > 0) {
      // Defer so the server finishes initializing first
      setTimeout(() => {
        for (const info of toResume) {
          console.log(`[auto-resume] Resuming instance ${info.id} (${info.name}) in ${info.cwd}`);
          this.resume(info.id);
        }
      }, 500);
    }
  }

  private setupListeners(): void {
    this.discovery.on('update', (status: InstanceStatusFile, filePath: string) => {
      const existing = this.instances.get(status.id);
      const info: InstanceInfo = {
        id: status.id,
        name: existing?.name || status.id,
        managed: this.managedIds.has(status.id),
        cwd: status.cwd,
        gitBranch: status.gitBranch,
        state: status.state,
        ticket: status.ticket,
        subtask: status.subtask,
        progress: status.progress,
        currentTool: status.currentTool,
        lastUpdated: status.lastUpdated,
        model: status.model || existing?.model,
        createdAt: existing?.createdAt,
        claudeSessionId: existing?.claudeSessionId,
      };
      this.instances.set(status.id, info);
      this.emit('update', info);
    });

    this.discovery.on('remove', (id: string) => {
      if (this.instances.has(id) && !this.managedIds.has(id)) {
        this.instances.delete(id);
        this.emit('remove', id);
      }
    });

    this.ptyManager.on('data', (instanceId: string, data: string) => {
      this.scrollbackBuffer.append(instanceId, data);
    });

    this.ptyManager.on('exit', (instanceId: string, exitCode: number) => {
      const info = this.instances.get(instanceId);
      if (info) {
        info.state = 'stopped';
        info.stoppedAt = Date.now();
        info.lastUpdated = Date.now();
        this.emit('update', info);
        this.scrollbackBuffer.flushAll();
        this.sessionStore.save(info);
      }
      this.emit('pty:exit', instanceId, exitCode);
    });
  }

  launch(payload: LaunchPayload): InstanceInfo {
    const id = generateInstanceId();
    const dirName = payload.cwd.split('/').filter(Boolean).pop() || 'instance';
    const now = Date.now();
    const info: InstanceInfo = {
      id,
      name: payload.autoName ? dirName : (payload.name || id),
      managed: true,
      cwd: payload.cwd,
      gitBranch: getGitBranch(payload.cwd),
      state: 'launching',
      lastUpdated: now,
      createdAt: now,
      model: payload.model,
      permissionMode: payload.permissionMode,
    };

    this.instances.set(id, info);
    this.managedIds.add(id);
    if (payload.autoName) this.autoNameIds.add(id);
    this.subscribers.set(id, new Set());

    try {
      this.ptyManager.spawn(id, payload.cwd, {
        model: payload.model,
        permissionMode: payload.permissionMode,
      });
    } catch (err) {
      info.state = 'stopped';
      this.emit('update', info);
      return info;
    }

    this.emit('update', info);
    this.sessionStore.save(info);
    this.scheduleLaunchTransition(id);
    return info;
  }

  /** Transition launching → running after 3s if nothing else has changed the state. */
  private scheduleLaunchTransition(instanceId: string): void {
    setTimeout(() => {
      const info = this.instances.get(instanceId);
      if (info && info.state === 'launching') {
        info.state = 'running';
        info.lastUpdated = Date.now();
        this.emit('update', info);
      }
    }, 3000);
  }

  kill(instanceId: string): void {
    this.ptyManager.kill(instanceId);
    const info = this.instances.get(instanceId);
    if (info) {
      info.state = 'stopped';
      info.stoppedAt = Date.now();
      info.lastUpdated = Date.now();
      this.emit('update', info);
      this.scrollbackBuffer.flushAll();
      this.sessionStore.save(info);
    }
  }

  resume(instanceId: string): InstanceInfo | null {
    const old = this.instances.get(instanceId);
    if (!old || !old.managed) return null;

    const newId = generateInstanceId();
    const now = Date.now();
    // Only use --resume with a real session ID from hooks; otherwise use --continue
    const resumeId = old.claudeSessionId || undefined;

    const info: InstanceInfo = {
      id: newId,
      name: old.name,
      managed: true,
      cwd: old.cwd,
      state: 'launching',
      lastUpdated: now,
      createdAt: now,
      model: old.model,
      permissionMode: old.permissionMode,
      previousInstanceId: instanceId,
      gitBranch: getGitBranch(old.cwd) || old.gitBranch,
    };

    this.instances.set(newId, info);
    this.managedIds.add(newId);
    this.subscribers.set(newId, new Set());

    try {
      this.ptyManager.spawn(newId, old.cwd, {
        model: old.model,
        permissionMode: old.permissionMode,
        claudeSessionId: resumeId,
        resume: true,
      });
    } catch (err) {
      info.state = 'stopped';
      this.emit('update', info);
      return info;
    }

    this.emit('update', info);
    this.sessionStore.save(info);
    this.scheduleLaunchTransition(newId);

    // Remove the old stopped instance from the list and disk
    this.instances.delete(instanceId);
    this.managedIds.delete(instanceId);
    this.sessionStore.remove(instanceId);
    this.scrollbackBuffer.remove(instanceId);
    this.emit('remove', instanceId);

    return info;
  }

  dismiss(instanceId: string): void {
    this.instances.delete(instanceId);
    this.managedIds.delete(instanceId);
    this.subscribers.delete(instanceId);
    this.sessionStore.remove(instanceId);
    this.scrollbackBuffer.remove(instanceId);
    this.emit('remove', instanceId);
  }

  getScrollback(instanceId: string): string {
    return this.scrollbackBuffer.getBuffer(instanceId);
  }

  remove(instanceId: string): void {
    this.instances.delete(instanceId);
    this.managedIds.delete(instanceId);
    this.subscribers.delete(instanceId);
    this.emit('remove', instanceId);
  }

  handleHookUpdate(data: InstanceStatusFile): void {
    const existing = this.instances.get(data.id);
    // Auto-name: use topic (first user prompt) or subtask from hook data
    let name = existing?.name || data.id;
    if (this.autoNameIds.has(data.id)) {
      const autoName = data.topic || data.subtask;
      if (autoName) {
        name = autoName;
        this.autoNameIds.delete(data.id);
      }
    }

    // Capture claude session ID from hook data
    const claudeSessionId = data.sessionId || existing?.claudeSessionId;

    const info: InstanceInfo = {
      id: data.id,
      name,
      managed: this.managedIds.has(data.id),
      cwd: data.cwd,
      gitBranch: data.gitBranch,
      state: data.state,
      ticket: data.ticket,
      subtask: data.subtask,
      progress: data.progress,
      currentTool: data.currentTool,
      lastUpdated: data.lastUpdated,
      model: data.model || existing?.model,
      createdAt: existing?.createdAt,
      claudeSessionId,
    };
    this.instances.set(data.id, info);
    this.emit('update', info);

    // Save to session store on meaningful hook updates for managed instances
    if (this.managedIds.has(data.id) && claudeSessionId) {
      this.sessionStore.save(info);
    }
  }

  getAll(): InstanceInfo[] {
    return Array.from(this.instances.values());
  }

  get(id: string): InstanceInfo | undefined {
    return this.instances.get(id);
  }

  isManaged(id: string): boolean {
    return this.managedIds.has(id);
  }

  /** Save all running instances as stopped (for graceful shutdown). */
  saveAllAsStopped(): void {
    const now = Date.now();
    for (const [id, info] of this.instances) {
      if (this.managedIds.has(id) && info.state !== 'stopped') {
        info.state = 'stopped';
        info.stoppedAt = now;
        info.lastUpdated = now;
        this.sessionStore.save(info, { autoResume: true });
      }
    }
  }

  startStaleCheck(): void {
    this.staleTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, info] of this.instances) {
        if (info.state === 'stopped') continue;

        // Refresh git branch for active managed instances
        if (this.managedIds.has(id) && info.state !== 'launching') {
          const branch = getGitBranch(info.cwd);
          if (branch && branch !== info.gitBranch) {
            info.gitBranch = branch;
            this.emit('update', info);
          }
        }

        if (info.state !== 'stale' && info.state !== 'launching') {
          if (now - info.lastUpdated > STALE_THRESHOLD_MS) {
            info.state = 'stale';
            this.emit('update', info);
          }
        }
      }
    }, 10_000);
  }

  stop(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.discovery.stop();
  }
}
