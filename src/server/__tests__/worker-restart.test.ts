import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { IPtyManager } from '../pty-manager.js';
import type { DiscoveryService } from '../discovery.js';
import type { SessionStore } from '../session-store.js';
import type { ScrollbackBuffer } from '../scrollback-buffer.js';
import type { SettingsManager } from '../settings-manager.js';
import type { InstanceInfo } from '../../shared/protocol.js';

const dirs = await vi.hoisted(async () => {
  const [{ default: fsMod }, { default: osMod }, { default: pathMod }] = await Promise.all([
    import('fs'), import('os'), import('path'),
  ]);
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mob-wrestart-'));
  const instances = pathMod.join(root, 'instances');
  fsMod.mkdirSync(instances);
  return { root, instances };
});

vi.mock('../util/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../util/platform.js', () => ({
  getInstancesDir: () => dirs.instances,
  getSessionsDir: () => dirs.root,
  getScrollbackDir: () => dirs.root,
  resolvePath: (p: string) => p,
  getGitBranch: () => undefined,
  getGitRoot: () => undefined,
  getGitRemoteUrl: () => undefined,
  getGitBranchAsync: async () => undefined,
}));

import { InstanceManager } from '../instance-manager.js';

class FakePtyManager extends EventEmitter implements IPtyManager {
  live = new Set<string>();
  spawn = vi.fn((id: string) => { this.live.add(id); });
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn((id: string) => { this.live.delete(id); });
  has(id: string): boolean { return this.live.has(id); }
  getAll(): Map<string, unknown> { return new Map([...this.live].map(id => [id, null])); }
}

type SaveCall = [InstanceInfo, { autoResume?: boolean } | undefined];

function setup() {
  const ptyManager = new FakePtyManager();
  const discovery = Object.assign(new EventEmitter(), { stop: vi.fn() }) as unknown as DiscoveryService;
  const saves: SaveCall[] = [];
  const sessionStore = {
    loadAll: vi.fn(() => []),
    save: vi.fn((info: InstanceInfo, opts?: { autoResume?: boolean }) => { saves.push([info, opts]); }),
    remove: vi.fn(),
  } as unknown as SessionStore;
  const scrollbackBuffer = {
    append: vi.fn(), getBuffer: vi.fn(() => ''), getTail: vi.fn(() => ''), flushAll: vi.fn(), remove: vi.fn(),
  } as unknown as ScrollbackBuffer;
  const settingsManager = { get: () => ({ jira: {} }), update: vi.fn() } as unknown as SettingsManager;
  const manager = new InstanceManager(ptyManager, discovery, sessionStore, scrollbackBuffer, settingsManager);
  return { manager, ptyManager, sessionStore, saves };
}

describe('InstanceManager.saveAllForWorkerRestart', () => {
  let cwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    cwd = fs.mkdtempSync(path.join(dirs.root, 'proj-'));
  });

  afterEach(() => { vi.useRealTimers(); });

  it('persists a live instance without marking it stopped', () => {
    const { manager, saves } = setup();
    const info = manager.launch({ cwd, name: 'alive' });
    saves.length = 0;

    manager.saveAllForWorkerRestart();

    expect(manager.get(info.id)?.state).not.toBe('stopped');
    const saved = saves.find(([i]) => i.id === info.id);
    expect(saved).toBeDefined();
    expect(saved?.[0].state).not.toBe('stopped');
    expect(saved?.[1]?.autoResume).toBe(true);
  });

  it('leaves the PTY alone — the supervisor still owns it', () => {
    const { manager, ptyManager } = setup();
    const info = manager.launch({ cwd, name: 'alive' });

    manager.saveAllForWorkerRestart();

    expect(ptyManager.kill).not.toHaveBeenCalled();
    expect(ptyManager.has(info.id)).toBe(true);
  });

  it('saveAllAsStopped still marks stopped, for single-process shutdown', () => {
    const { manager, saves } = setup();
    const info = manager.launch({ cwd, name: 'doomed' });
    saves.length = 0;

    manager.saveAllAsStopped();

    expect(manager.get(info.id)?.state).toBe('stopped');
    const saved = saves.find(([i]) => i.id === info.id);
    expect(saved?.[0].state).toBe('stopped');
  });

  it('records every managed instance, not just the running ones', () => {
    const { manager, saves } = setup();
    const a = manager.launch({ cwd, name: 'a' });
    const b = manager.launch({ cwd, name: 'b' });
    saves.length = 0;

    manager.saveAllForWorkerRestart();

    expect(saves.map(([i]) => i.id).sort()).toEqual([a.id, b.id].sort());
  });
});
