import { EventEmitter } from 'events';
import { PtyManager, findProjectDirForSession, decodeProjectDir, type IPtyManager } from './pty-manager.js';
import { DiscoveryService } from './discovery.js';
import { SessionStore } from './session-store.js';
import { ScrollbackBuffer } from './scrollback-buffer.js';
import type { InstanceInfo, InstanceState, LaunchConflicts, LaunchPayload } from '../shared/protocol.js';
import type { InstanceStatusFile } from './types.js';
import type { SettingsManager } from './settings-manager.js';
import { generateInstanceId } from './util/id.js';
import { STALE_THRESHOLD_MS, HOOK_SILENCE_THRESHOLD_MS } from '../shared/constants.js';
import { getGitBranch, getGitRoot, getGitRemoteUrl, resolvePath } from './util/platform.js';
import { fetchJiraIssue, type JiraAuth } from './jira-client.js';
import { detectStateFromTerminal, hasExplicitIdleMarker } from './terminal-state-detector.js';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { loadProjectConfig, type ProjectConfig } from './project-config.js';
import { createLogger } from './util/logger.js';

const logger = createLogger('instance-mgr');

const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/;

/** Trivial prompts that should not become instance titles. */
const TRIVIAL_PROMPTS = new Set([
  'y', 'n', 'yes', 'no', 'ok', 'okay', 'sure', 'thanks', 'thank you',
  'do it', 'go ahead', 'continue', 'proceed', 'lgtm', 'looks good',
  'retry', 'try again', 'next', 'done', 'stop', 'cancel', 'nevermind',
  'nvm', 'skip', 'approve', 'deny', 'accept', 'reject', 'perfect',
  'great', 'nice', 'good', 'correct', 'right', 'exactly', 'yep', 'nope',
]);

const FILLER_PREFIXES = /^(please\s+|can you\s+|could you\s+|i need you to\s+|i want you to\s+|i'd like you to\s+|go ahead and\s+|help me\s+|let's\s+|now\s+|ok\s+|okay\s+)/i;

const TRAILING_STOP_WORDS = /\s+(the|a|an|in|on|at|to|for|of|with|from|and|or|but|that|this|is|are|was|were)$/i;

/**
 * Extract a 2-4 word title from a user prompt.
 * Returns null if the prompt is trivial or too short.
 */
export function extractTitle(prompt: string): string | null {
  if (!prompt) return null;

  const firstLine = prompt.split('\n')[0].trim();
  const lower = firstLine.toLowerCase().replace(/[.!?,;:]+$/, '').trim();
  if (lower.length < 8 || TRIVIAL_PROMPTS.has(lower)) return null;

  let cleaned = firstLine.replace(FILLER_PREFIXES, '').trim();
  if (!cleaned) cleaned = firstLine;

  const ARTICLES = new Set(['the', 'a', 'an']);
  const words = cleaned.split(/\s+/).filter(w => w.length > 0 && !ARTICLES.has(w.toLowerCase()));
  if (words.length === 0) return null;

  let title = words.slice(0, 4).join(' ');
  title = title.replace(/[.!?,;:]+$/, '');
  title = title.replace(TRAILING_STOP_WORDS, '');

  // Capitalize first letter only
  title = title.charAt(0).toUpperCase() + title.slice(1);

  if (title.length < 3) return null;
  return title;
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
  private ptyManager: IPtyManager;
  private discovery: DiscoveryService;
  private sessionStore: SessionStore;
  private scrollbackBuffer: ScrollbackBuffer;
  private settingsManager: SettingsManager;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private jiraCache = new Map<string, { status: string | null; assignee: string | null; title: string | null; fetchedAt: number }>();
  public subscribers = new Map<string, Set<import('ws').WebSocket>>();

  constructor(
    ptyManager: IPtyManager,
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
    const adopted: typeof sessions = [];
    for (const info of sessions) {
      this.instances.set(info.id, info);
      this.managedIds.add(info.id);
      this.applyTicketFields(info);
      if (this.ptyManager.has(info.id)) {
        // PTY is still alive (supervisor kept it across our restart) — adopt
        // it as-is rather than respawning. Start as 'idle': the next stale
        // tick promotes to 'running' if a spinner is in the recent window;
        // wrong-idle self-corrects within 10s, wrong-running does not.
        info.state = 'idle';
        info.lastUpdated = Date.now();
        adopted.push(info);
      } else if (info.autoResume) {
        toResume.push(info);
      }
    }
    for (const info of adopted) {
      this.log.info(`[adopt] live PTY survived restart: ${info.id} (${info.name})`);
      this.emit('update', info);
    }
    // Kill any PTYs in the supervisor that aren't in our session store
    // (orphans from sessions that were dismissed while the worker was down).
    for (const id of this.ptyManager.getAll().keys()) {
      if (!this.instances.has(id)) {
        this.log.info(`[orphan] killing orphan PTY ${id} not in session store`);
        this.ptyManager.kill(id);
      }
    }
    // Auto-resume instances that aren't alive
    if (toResume.length > 0) {
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

      // Track terminal title (OSC 2) for periodic refresh, but don't use for
      // auto-naming — OSC 2 titles are tool-level status strings like "Bash:start"
      // which change too rapidly and aren't meaningful task descriptions.
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

    // Schedule async JIRA fetch if we have a JIRA key and credentials, and missing info
    if ((!info.ticketStatus || !info.ticketAssignee || !info.ticketTitle) && info.ticket && JIRA_KEY_RE.test(info.ticket)) {
      if (this.buildJiraAuth()) {
        this.fetchAndSetJiraInfo(info.id, info.ticket);
      }
    }
  }

  /** Build a JiraAuth object from current settings, or null if not configured. */
  private buildJiraAuth(): JiraAuth | null {
    const jira = this.settingsManager.get().jira;

    // OAuth takes priority if configured
    if (jira.oauthAccessToken && jira.oauthRefreshToken && jira.oauthClientId && jira.cloudId) {
      return {
        type: 'oauth',
        cloudId: jira.cloudId,
        accessToken: jira.oauthAccessToken,
        refreshToken: jira.oauthRefreshToken,
        clientId: jira.oauthClientId,
        clientSecret: jira.oauthClientSecret,
        tokenExpiry: jira.oauthTokenExpiry,
        onTokenRefresh: (tokens) => {
          this.settingsManager.update({
            jira: {
              oauthAccessToken: tokens.accessToken,
              oauthRefreshToken: tokens.refreshToken,
              oauthTokenExpiry: Date.now() + tokens.expiresIn * 1000,
            },
          });
        },
      };
    }

    // Fall back to Basic Auth
    if (jira.baseUrl && jira.email && jira.apiToken) {
      return {
        type: 'basic',
        baseUrl: jira.baseUrl,
        email: jira.email,
        apiToken: jira.apiToken,
      };
    }

    return null;
  }

  private async fetchAndSetJiraInfo(instanceId: string, ticketKey: string): Promise<void> {
    // Check cache
    const cached = this.jiraCache.get(ticketKey);
    if (cached && Date.now() - cached.fetchedAt < 60_000) {
      const info = this.instances.get(instanceId);
      if (info) {
        if (!info.ticketStatus && cached.status) info.ticketStatus = cached.status;
        if (!info.ticketAssignee && cached.assignee) info.ticketAssignee = cached.assignee;
        if (!info.ticketTitle && cached.title) info.ticketTitle = cached.title;
        this.emit('update', info);
      }
      return;
    }

    const auth = this.buildJiraAuth();
    if (!auth) return;
    const result = await fetchJiraIssue(auth, ticketKey);
    if (result) {
      this.jiraCache.set(ticketKey, { ...result, fetchedAt: Date.now() });
      const info = this.instances.get(instanceId);
      if (info) {
        if (result.status) info.ticketStatus = result.status;
        if (result.assignee) info.ticketAssignee = result.assignee;
        if (result.title) info.ticketTitle = result.title;
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

    this.instances.set(id, info);
    this.managedIds.add(id);
    if (autoName) this.autoNameIds.add(id);
    this.subscribers.set(id, new Set());

    this.applyTicketFields(info);

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

  /**
   * Transition launching → idle after 3s if nothing else has changed the state.
   * Idle is the correct default: after spawn, Claude sits at its prompt waiting
   * for user input. Real activity (UserPromptSubmit, PreToolUse) will flip it
   * back to 'running' via the hook handler.
   */
  private scheduleLaunchTransition(instanceId: string): void {
    setTimeout(() => {
      const info = this.instances.get(instanceId);
      if (info && info.state === 'launching') {
        info.state = 'idle';
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

    // Claude stores session files keyed by the cwd where Claude was started.
    // If Claude cd'd to a different dir during the session, the stored cwd may
    // be wrong. Look up the actual project dir containing the session file.
    let resumeCwd = old.cwd;
    if (resumeId) {
      const projectDir = findProjectDirForSession(resumeId);
      if (projectDir) {
        const decoded = decodeProjectDir(projectDir);
        if (decoded !== old.cwd && fs.existsSync(decoded)) {
          this.log.info(`resume: session ${resumeId} lives in ${decoded}, not ${old.cwd} — using ${decoded}`);
          resumeCwd = decoded;
        }
      }
    }

    const info: InstanceInfo = {
      id: newId,
      name: old.name,
      managed: true,
      cwd: resumeCwd,
      state: 'launching',
      lastUpdated: now,
      createdAt: now,
      project: old.project,
      model: old.model,
      permissionMode: old.permissionMode,
      previousInstanceId: instanceId,
      gitRoot: getGitRoot(resumeCwd) || old.gitRoot,
      gitRemoteUrl: getGitRemoteUrl(resumeCwd) || old.gitRemoteUrl,
      gitBranch: getGitBranch(resumeCwd) || old.gitBranch,
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

    this.applyTicketFields(info);

    try {
      this.ptyManager.spawn(newId, resumeCwd, {
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

    // --- Hook-event state refinement ---
    // Trust hook-reported states directly. The hook scripts already map events
    // to correct states (PreToolUse→running, Notification→idle, Stop→idle, etc.).
    // Only override for specific cases where we have better information.

    // PreToolUse with AskUserQuestion: Claude is about to ask a question.
    if (data.hookEvent === 'PreToolUse' && data.currentTool === 'AskUserQuestion') {
      data.state = 'waiting';
    }
    // Notification/Stop: hook already sets idle — trust it, don't override with
    // terminal scraping (which caused false "waiting" from words in output).
    // Terminal-based detection is only used as a stale fallback (see startStaleCheck).

    if (data.state === 'stopped') {
      this.log.info(`hook update with stopped state: id=${data.id} managed=${this.managedIds.has(data.id)} ptyAlive=${this.ptyManager.has(data.id)}`);
      // Ignore stopped state from hooks if the PTY is still alive — this happens when
      // Claude subtasks/subagents end and fire SessionEnd with the parent's instance ID
      if (this.managedIds.has(data.id) && this.ptyManager.has(data.id)) {
        this.log.info(`ignoring stopped hook for ${data.id} — PTY still alive (likely subtask exit)`);
        return;
      }
    }
    // Auto-name: derive short title from prompt, or use subtask
    let name = existing?.name || data.id;
    if (this.autoNameIds.has(data.id)) {
      if (data.subtask) {
        // Subtask from .mob-task.json always takes priority
        name = data.subtask;
      } else if (data.topic) {
        const count = (this.promptCount.get(data.id) || 0) + 1;
        this.promptCount.set(data.id, count);
        const title = extractTitle(data.topic);
        if (title && title !== existing?.name) {
          name = title;
        }
        // If extractTitle returned null (trivial prompt), keep existing name
      }
    }

    // Capture claude session ID from hook data
    const claudeSessionId = data.sessionId || existing?.claudeSessionId;

    // For managed instances, preserve the original spawn cwd so resume works
    // even if Claude cd'd elsewhere. Claude's session files are keyed by the
    // original cwd, so spawning in the new cwd would break --resume.
    const isManaged = this.managedIds.has(data.id);
    const cwd = isManaged ? (existing?.cwd || data.cwd) : data.cwd;

    // Topic comes from UserPromptSubmit hook — it's the user's latest prompt
    // (truncated to 80 chars by the hook script). Preserve the previous value
    // when the current hook event isn't a prompt submit.
    const lastPrompt = data.topic || existing?.lastPrompt;

    const info: InstanceInfo = {
      id: data.id,
      name,
      managed: isManaged,
      cwd,
      project: existing?.project,
      gitRoot: existing?.gitRoot || getGitRoot(cwd),
      gitRemoteUrl: existing?.gitRemoteUrl || getGitRemoteUrl(cwd),
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
      lastPrompt,
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

        // (OSC 2 title refresh removed — those are tool-status strings, not task names)

        // Terminal-based state fallback for managed instances
        if (this.managedIds.has(id)) {
          const hookSilent = !info.lastHookUpdate || (now - info.lastHookUpdate > HOOK_SILENCE_THRESHOLD_MS);

          // PTY dead but state still 'running'/'idle' → mark stopped
          if (!this.ptyManager.has(id)) {
            this.log.info(`stale check: PTY dead for ${id} (${info.name}), marking stopped`);
            info.state = 'stopped';
            info.stoppedAt = now;
            info.lastUpdated = now;
            this.emit('update', info);
            this.sessionStore.save(info);
            continue;
          }

          // Always-on demotion: flip running → idle every cycle when both
          // conditions are true:
          //   (a) the detector returns 'idle' (no "esc to interrupt" anywhere
          //       in the recent window — Claude isn't actively processing)
          //   (b) an explicit idle marker (mode footer) is present in the
          //       prompt zone — positive evidence Claude is at its prompt
          // Both conditions are required because during running, the mode
          // footer is still rendered (with " · esc to interrupt" appended) —
          // we'd false-demote if we used (b) alone. This fixes "fresh Claude
          // shows Running forever" without waiting for the hook-silence
          // threshold.
          if (info.state === 'running') {
            const tail = this.scrollbackBuffer.getTail(id, 2500);
            const detected = detectStateFromTerminal(tail);
            if (detected === 'idle' && hasExplicitIdleMarker(tail)) {
              this.log.info(`demote (no esc-to-interrupt + mode footer): ${id} (${info.name}) running → idle`);
              info.state = 'idle';
              info.lastUpdated = now;
              this.emit('update', info);
              continue;
            }
          }

          // Bidirectional fallback when hooks have been silent for a while.
          // Trusted to both promote idle→running and demote running→idle since
          // the detector now distinguishes both with positive evidence.
          if (hookSilent) {
            const tail = this.scrollbackBuffer.getTail(id, 2500);
            const detected = detectStateFromTerminal(tail);
            if (detected !== info.state) {
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

  /** Recompute ticket URLs and re-fetch JIRA info for all instances (call after JIRA settings change). */
  refreshTicketFields(): void {
    // Clear JIRA cache so the next fetches get fresh data with new credentials
    this.jiraCache.clear();

    for (const info of this.instances.values()) {
      // Re-derive ticket from branch if not set
      if (!info.ticket) {
        const derived = extractJiraKey(info.gitBranch);
        if (derived) info.ticket = derived;
      }
      info.ticketUrl = this.computeTicketUrl(info.ticket);

      // Trigger a fresh fetch — keep existing status/assignee/title visible
      // until the new values arrive (avoids flash of missing badges)
      if (info.ticket && JIRA_KEY_RE.test(info.ticket) && this.buildJiraAuth()) {
        this.fetchAndSetJiraInfo(info.id, info.ticket);
      }

      this.emit('update', info);
    }
  }

  stop(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.discovery.stop();
  }
}
