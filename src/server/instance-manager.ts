import { EventEmitter } from 'events';
import { PtyManager } from './pty-manager.js';
import { DiscoveryService } from './discovery.js';
import { SessionStore } from './session-store.js';
import { ScrollbackBuffer } from './scrollback-buffer.js';
import type { InstanceInfo, InstanceState, LaunchConflicts, LaunchPayload } from '../shared/protocol.js';
import type { InstanceStatusFile } from './types.js';
import type { SettingsManager } from './settings-manager.js';
import { generateInstanceId } from './util/id.js';
import { STALE_THRESHOLD_MS, HOOK_SILENCE_THRESHOLD_MS } from '../shared/constants.js';
import { getGitBranch, getGitRoot, getGitRemoteUrl, resolvePath } from './util/platform.js';
import { fetchJiraStatus } from './jira-client.js';
import { detectStateFromTerminal } from './terminal-state-detector.js';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { loadProjectConfig, type ProjectConfig } from './project-config.js';
import { createLogger } from './util/logger.js';

const logger = createLogger('instance-mgr');

const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/;

// OSC 2 = Set Window Title: \x1B]2;...title...\x07  (or \x1B\\ as terminator)
const OSC2_RE = /\x1B\]2;([^\x07\x1B]*?)(?:\x07|\x1B\\)/;
const OSC2_RE_GLOBAL = /\x1B\]2;([^\x07\x1B]*?)(?:\x07|\x1B\\)/g;

function cleanTerminalTitle(raw: string): string | null {
  let title = raw.trim();
  if (title.toLowerCase().startsWith('claude:')) title = title.slice(7).trim();
  return title || null;
}

function extractTerminalTitle(data: string): string | null {
  const match = data.match(OSC2_RE);
  if (!match) return null;
  return cleanTerminalTitle(match[1]);
}

function extractLastTerminalTitle(data: string): string | null {
  let last: string | null = null;
  let match;
  while ((match = OSC2_RE_GLOBAL.exec(data)) !== null) {
    const title = cleanTerminalTitle(match[1]);
    if (title) last = title;
  }
  return last;
}

export function extractJiraKey(branch: string | undefined): string | null {
  if (!branch) return null;
  const m = branch.match(JIRA_KEY_RE);
  return m ? m[1] : null;
}

export class InstanceManager extends EventEmitter {
  private log = logger;

  private instances = new Map<string, InstanceInfo>();
  private managedIds = new Set<string>();
  private autoNameIds = new Set<string>();
  private promptCount = new Map<string, number>();
  private teardownCommands = new Map<string, string[]>();
  private ptyManager: PtyManager;
  private discovery: DiscoveryService;
  private sessionStore: SessionStore;
  private scrollbackBuffer: ScrollbackBuffer;
  private settingsManager: SettingsManager;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private jiraStatusCache = new Map<string, { status: string; fetchedAt: number }>();
  public subscribers = new Map<string, Set<import('ws').WebSocket>>();

  constructor(
    ptyManager: PtyManager,
    discovery: DiscoveryService,
    sessionStore: SessionStore,
    scrollbackBuffer: ScrollbackBuffer,
    settingsManager: SettingsManager,
  ) {
    super();
    this.ptyManager = ptyManager;
    this.discovery = discovery;
    this.sessionStore = sessionStore;
    this.scrollbackBuffer = scrollbackBuffer;
    this.settingsManager = settingsManager;
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
          this.log.info(`[auto-resume] Resuming instance ${info.id} (${info.name}) in ${info.cwd}`);
          this.resume(info.id);
        }
      }, 500);
    }
  }

  private setupListeners(): void {
    this.discovery.on('update', (status: InstanceStatusFile) => {
      this.log.info(`discovery update: id=${status.id} state=${status.state} topic=${status.topic || '(none)'}`);
      this.handleHookUpdate(status);
    });

    this.discovery.on('remove', (id: string) => {
      if (this.instances.has(id) && !this.managedIds.has(id)) {
        this.instances.delete(id);
        this.emit('remove', id);
      }
    });

    this.ptyManager.on('data', (instanceId: string, data: string) => {
      this.scrollbackBuffer.append(instanceId, data);

      // Capture terminal title (OSC 2) set by Claude via printf '\e]2;...\a'
      if (this.autoNameIds.has(instanceId) && data.includes('\x1B]2;')) {
        const title = extractTerminalTitle(data);
        if (title) {
          const info = this.instances.get(instanceId);
          if (info && info.name !== title) {
            info.name = title;
            info.lastUpdated = Date.now();
            this.emit('update', info);
          }
        }
      }
    });

    this.ptyManager.on('exit', (instanceId: string, exitCode: number) => {
      const info = this.instances.get(instanceId);
      this.log.info(`PTY exit event: id=${instanceId} exitCode=${exitCode} name="${info?.name}" state=${info?.state}`);
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

  /** Compute ticketUrl from a ticket key and current JIRA settings. */
  private computeTicketUrl(ticket: string | undefined): string | undefined {
    if (!ticket) return undefined;
    if (ticket.startsWith('http')) return ticket;
    const { baseUrl } = this.settingsManager.get().jira;
    if (baseUrl) {
      return `${baseUrl}/browse/${ticket}`;
    }
    return undefined;
  }

  /** Apply ticket derivation (from branch), ticketUrl, and ticketStatus to an InstanceInfo. */
  private applyTicketFields(info: InstanceInfo, explicitTicket?: string, explicitTicketStatus?: string): void {
    // Derive ticket from branch if not explicitly set
    if (!info.ticket) {
      const derived = extractJiraKey(info.gitBranch);
      if (derived) info.ticket = derived;
    }
    info.ticketUrl = this.computeTicketUrl(info.ticket);

    // Use explicit status if provided
    if (explicitTicketStatus) {
      info.ticketStatus = explicitTicketStatus;
    }

    // Schedule async JIRA status fetch if we have a JIRA key and credentials, and no explicit status
    if (!info.ticketStatus && info.ticket && JIRA_KEY_RE.test(info.ticket)) {
      const jira = this.settingsManager.get().jira;
      if (jira.baseUrl && jira.email && jira.apiToken) {
        this.fetchAndSetJiraStatus(info.id, info.ticket);
      }
    }
  }

  private async fetchAndSetJiraStatus(instanceId: string, ticketKey: string): Promise<void> {
    // Check cache
    const cached = this.jiraStatusCache.get(ticketKey);
    if (cached && Date.now() - cached.fetchedAt < 60_000) {
      const info = this.instances.get(instanceId);
      if (info && !info.ticketStatus) {
        info.ticketStatus = cached.status;
        this.emit('update', info);
      }
      return;
    }

    const { baseUrl, email, apiToken } = this.settingsManager.get().jira;
    const status = await fetchJiraStatus(baseUrl, email, apiToken, ticketKey);
    if (status) {
      this.jiraStatusCache.set(ticketKey, { status, fetchedAt: Date.now() });
      const info = this.instances.get(instanceId);
      if (info) {
        info.ticketStatus = status;
        this.emit('update', info);
      }
    }
  }

  checkConflicts(cwd: string): LaunchConflicts {
    const resolved = resolvePath(cwd);
    let cwdExists = false;
    try {
      cwdExists = fs.statSync(resolved).isDirectory();
    } catch { /* doesn't exist */ }

    const branch = getGitBranch(cwd);
    const sameDirInstances: LaunchConflicts['sameDirInstances'] = [];
    const sameBranchInstances: LaunchConflicts['sameBranchInstances'] = [];

    for (const info of this.instances.values()) {
      if (info.state === 'stopped') continue;

      const infoResolved = resolvePath(info.cwd);
      if (infoResolved === resolved) {
        sameDirInstances.push({ id: info.id, name: info.name, state: info.state });
      }

      if (branch && info.gitBranch && info.gitBranch === branch && infoResolved !== resolved) {
        sameBranchInstances.push({ id: info.id, name: info.name, branch: info.gitBranch, cwd: info.cwd });
      }
    }

    return { cwd, cwdExists, sameDirInstances, sameBranchInstances };
  }

  cloneRepo(sourceCwd: string, targetDir: string): void {
    const resolved = resolvePath(sourceCwd);
    execFileSync('git', ['clone', resolved, targetDir], {
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  launch(payload: LaunchPayload): InstanceInfo {
    // If cloneDir is set, clone the repo first
    let effectiveCwd = payload.cwd;
    if (payload.cloneDir) {
      this.cloneRepo(payload.cwd, payload.cloneDir);
      effectiveCwd = payload.cloneDir;
    }

    // Create directory if requested
    if (payload.createDir) {
      const resolved = resolvePath(effectiveCwd);
      fs.mkdirSync(resolved, { recursive: true });
      this.log.info(`Created directory: ${resolved}`);
    }

    // Load per-project config (.mob/config.json) and apply defaults
    const projectConfig = loadProjectConfig(effectiveCwd);
    const model = payload.model || projectConfig?.defaults?.model;
    const permissionMode = payload.permissionMode || projectConfig?.defaults?.permissionMode;
    const autoName = payload.autoName ?? projectConfig?.defaults?.autoName ?? true;

    const id = generateInstanceId();
    const dirName = effectiveCwd.split('/').filter(Boolean).pop() || 'instance';
    const now = Date.now();
    const info: InstanceInfo = {
      id,
      name: autoName ? dirName : (payload.name || id),
      managed: true,
      cwd: effectiveCwd,
      project: payload.project,
      gitRoot: getGitRoot(effectiveCwd),
      gitRemoteUrl: getGitRemoteUrl(effectiveCwd),
      gitBranch: getGitBranch(effectiveCwd),
      state: 'launching',
      lastUpdated: now,
      createdAt: now,
      model,
      permissionMode,
    };

    this.applyTicketFields(info);

    this.instances.set(id, info);
    this.managedIds.add(id);
    if (autoName) this.autoNameIds.add(id);
    this.subscribers.set(id, new Set());

    // Store teardown commands for later cleanup
    if (projectConfig?.teardown?.length) {
      this.teardownCommands.set(id, projectConfig.teardown);
    }

    try {
      this.ptyManager.spawn(id, effectiveCwd, {
        model,
        permissionMode,
        setupCommands: projectConfig?.setup,
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
    const info = this.instances.get(instanceId);
    this.log.info(`kill() called: id=${instanceId} name="${info?.name}" trace=${new Error().stack?.split('\n').slice(1, 4).map(s => s.trim()).join(' <- ')}`);

    // Write teardown commands into the PTY (visible to the user) before killing.
    // We avoid execFileSync('sh', ['-c', ...]) to prevent silent arbitrary command execution
    // from untrusted .mob/config.json files (RCE via supply chain).
    const teardown = this.teardownCommands.get(instanceId);
    if (teardown?.length && this.ptyManager.has(instanceId)) {
      for (const cmd of teardown) {
        this.log.info(`Running teardown for ${instanceId}: ${cmd}`);
        this.ptyManager.write(instanceId, cmd + '\r');
      }
      this.teardownCommands.delete(instanceId);
    }

    // Brief delay to let teardown commands start executing before kill
    const doKill = () => {
      this.ptyManager.kill(instanceId);
    };
    if (teardown?.length) {
      setTimeout(doKill, 500);
    } else {
      doKill();
    }
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
      project: old.project,
      model: old.model,
      permissionMode: old.permissionMode,
      previousInstanceId: instanceId,
      gitRoot: getGitRoot(old.cwd) || old.gitRoot,
      gitRemoteUrl: getGitRemoteUrl(old.cwd) || old.gitRemoteUrl,
      gitBranch: getGitBranch(old.cwd) || old.gitBranch,
    };

    this.instances.set(newId, info);
    this.managedIds.add(newId);
    if (this.autoNameIds.has(instanceId)) {
      this.autoNameIds.add(newId);
    }
    const oldPromptCount = this.promptCount.get(instanceId);
    if (oldPromptCount !== undefined) {
      this.promptCount.set(newId, oldPromptCount);
    }
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
    this.autoNameIds.delete(instanceId);
    this.promptCount.delete(instanceId);
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

  editInstance(instanceId: string, fields: { name?: string; project?: string; model?: string; permissionMode?: string }): boolean {
    const info = this.instances.get(instanceId);
    if (!info || !this.managedIds.has(instanceId)) return false;

    if (fields.name !== undefined) {
      info.name = fields.name;
      // Disable auto-naming if user explicitly sets a name
      if (fields.name) this.autoNameIds.delete(instanceId);
    }
    if (fields.project !== undefined) info.project = fields.project || undefined;
    if (fields.model !== undefined) info.model = fields.model || undefined;
    if (fields.permissionMode !== undefined) info.permissionMode = fields.permissionMode || undefined;

    info.lastUpdated = Date.now();
    this.emit('update', info);
    this.sessionStore.save(info);
    return true;
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

    // Notification events don't reliably indicate "needs input" — Claude fires them for
    // completion messages too. Verify via terminal output for managed instances.
    if (data.hookEvent === 'Notification') {
      if (this.managedIds.has(data.id)) {
        const tail = this.scrollbackBuffer.getTail(data.id, 500);
        const detected = detectStateFromTerminal(tail);
        if (detected === 'waiting') {
          this.log.info(`Notification for ${data.id} — terminal confirms waiting`);
          data.state = 'waiting';
        } else {
          this.log.info(`Notification for ${data.id} — terminal does not confirm waiting, keeping ${existing?.state || 'idle'}`);
          data.state = existing?.state || 'idle';
        }
      } else {
        data.state = existing?.state || 'idle';
      }
    }

    if (data.state === 'stopped') {
      this.log.info(`hook update with stopped state: id=${data.id} managed=${this.managedIds.has(data.id)} ptyAlive=${this.ptyManager.has(data.id)}`);
      // Ignore stopped state from hooks if the PTY is still alive — this happens when
      // Claude subtasks/subagents end and fire SessionEnd with the parent's instance ID
      if (this.managedIds.has(data.id) && this.ptyManager.has(data.id)) {
        this.log.info(`ignoring stopped hook for ${data.id} — PTY still alive (likely subtask exit)`);
        return;
      }
    }
    // Auto-name: use topic or subtask, refreshing every 5 prompts
    let name = existing?.name || data.id;
    if (this.autoNameIds.has(data.id)) {
      const autoName = data.subtask || data.topic;
      if (autoName) {
        // Track prompt count — topic is set on UserPromptSubmit events
        if (data.topic) {
          const count = (this.promptCount.get(data.id) || 0) + 1;
          this.promptCount.set(data.id, count);
          // Rename on first prompt and every 5 prompts after
          if (count === 1 || count % 5 === 0) {
            name = autoName;
          }
        } else {
          // subtask update without a prompt — always use it
          name = autoName;
        }
      }
    }

    // Capture claude session ID from hook data
    const claudeSessionId = data.sessionId || existing?.claudeSessionId;

    const info: InstanceInfo = {
      id: data.id,
      name,
      managed: this.managedIds.has(data.id),
      cwd: data.cwd,
      project: existing?.project,
      gitRoot: existing?.gitRoot || getGitRoot(data.cwd),
      gitRemoteUrl: existing?.gitRemoteUrl || getGitRemoteUrl(data.cwd),
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
    info.lastHookUpdate = Date.now();
    info.lastHookEvent = data.hookEvent || existing?.lastHookEvent;
    this.applyTicketFields(info, data.ticket, data.ticketStatus);
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
    this.log.info(`saveAllAsStopped() called — shutting down`);
    const now = Date.now();
    for (const [id, info] of this.instances) {
      if (this.managedIds.has(id) && info.state !== 'stopped') {
        this.log.info(`marking stopped for shutdown: id=${id} name="${info.name}"`);
        info.state = 'stopped';
        info.stoppedAt = now;
        info.lastUpdated = now;
        this.sessionStore.save(info, { autoResume: true });
      }
    }
  }

  private staleCheckCycle = 0;

  startStaleCheck(): void {
    this.staleTimer = setInterval(() => {
      const now = Date.now();
      this.staleCheckCycle++;

      for (const [id, info] of this.instances) {
        if (info.state === 'stopped') continue;

        // Tiered git branch refresh for managed instances
        if (this.managedIds.has(id) && info.state !== 'launching') {
          const shouldRefreshGit =
            info.state === 'running' || info.state === 'waiting'
              ? true                              // every cycle (10s)
              : this.staleCheckCycle % 6 === 0;   // idle: every 6th cycle (60s)

          if (shouldRefreshGit) {
            const branch = getGitBranch(info.cwd);
            if (branch && branch !== info.gitBranch) {
              info.gitBranch = branch;
              this.emit('update', info);
            }
          }
        }

        // Periodic title refresh from scrollback (~every 3 min)
        if (this.autoNameIds.has(id) && this.staleCheckCycle % 18 === 0) {
          const tail = this.scrollbackBuffer.getTail(id, 2000);
          const title = extractLastTerminalTitle(tail);
          if (title && title !== info.name) {
            this.log.info(`title refresh: ${id} "${info.name}" → "${title}"`);
            info.name = title;
            info.lastUpdated = now;
            this.emit('update', info);
          }
        }

        // Terminal-based state fallback for managed instances
        if (this.managedIds.has(id)) {
          const hookSilent = !info.lastHookUpdate || (now - info.lastHookUpdate > HOOK_SILENCE_THRESHOLD_MS);

          // Check if PTY is dead but state isn't stopped
          if (!this.ptyManager.has(id)) {
            this.log.info(`stale check: PTY dead for ${id} (${info.name}), marking stopped`);
            info.state = 'stopped';
            info.stoppedAt = now;
            info.lastUpdated = now;
            this.emit('update', info);
            this.sessionStore.save(info);
            continue;
          }

          // If hooks have been silent, try terminal-based detection
          if (hookSilent) {
            const tail = this.scrollbackBuffer.getTail(id, 500);
            const detected = detectStateFromTerminal(tail);
            if (detected && detected !== info.state) {
              this.log.info(`terminal fallback: ${id} (${info.name}) ${info.state} → ${detected}`);
              info.state = detected;
              info.lastUpdated = now;
              this.emit('update', info);
            }
          }
        }
      }
    }, 10_000);
  }

  /** Recompute ticket URLs for all instances (call after JIRA settings change). */
  refreshTicketFields(): void {
    for (const info of this.instances.values()) {
      const oldUrl = info.ticketUrl;
      info.ticketUrl = this.computeTicketUrl(info.ticket);
      if (info.ticketUrl !== oldUrl) {
        this.emit('update', info);
      }
    }
  }

  stop(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.discovery.stop();
  }
}
