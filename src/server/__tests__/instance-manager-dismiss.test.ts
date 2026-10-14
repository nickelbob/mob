import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { IPtyManager } from '../pty-manager.js';
import type { DiscoveryService } from '../discovery.js';
import type { SessionStore } from '../session-store.js';
import type { ScrollbackBuffer } from '../scrollback-buffer.js';
import type { SettingsManager } from '../settings-manager.js';

const dirs = await vi.hoisted(async () => {
  const [{ default: fsMod }, { default: osMod }, { default: pathMod }] = await Promise.all([
    import('fs'), import('os'), import('path'),
  ]);
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mob-dismiss-'));
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

function statusFile(id: string): string {
  return path.join(dirs.instances, `${id}.json`);
}

function setup() {
  const ptyManager = new FakePtyManager();
  const discovery = Object.assign(new EventEmitter(), { stop: vi.fn() }) as unknown as DiscoveryService;
  const sessionStore = { loadAll: vi.fn(() => []), save: vi.fn(), remove: vi.fn() } as unknown as SessionStore;
  const scrollbackBuffer = {
    append: vi.fn(), getBuffer: vi.fn(() => ''), getTail: vi.fn(() => ''), flushAll: vi.fn(), remove: vi.fn(),
  } as unknown as ScrollbackBuffer;
  const settingsManager = { get: () => ({ jira: {} }), update: vi.fn() } as unknown as SettingsManager;
  const manager = new InstanceManager(ptyManager, discovery, sessionStore, scrollbackBuffer, settingsManager);
  const removed: string[] = [];
  manager.on('remove', (id: string) => removed.push(id));
  return { manager, ptyManager, sessionStore, scrollbackBuffer, removed };
}

describe('InstanceManager.dismiss', () => {
  let cwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    cwd = fs.mkdtempSync(path.join(dirs.root, 'proj-'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills the live PTY of a running managed instance and drops every trace of it', () => {
    const { manager, ptyManager, sessionStore, scrollbackBuffer, removed } = setup();
    const info = manager.launch({ cwd, name: 'test' });
    fs.writeFileSync(statusFile(info.id), '{}');
    expect(ptyManager.has(info.id)).toBe(true);

    manager.dismiss(info.id);

    expect(ptyManager.kill).toHaveBeenCalledWith(info.id);
    expect(ptyManager.has(info.id)).toBe(false);
    expect(manager.get(info.id)).toBeUndefined();
    expect(manager.isManaged(info.id)).toBe(false);
    expect(manager.subscribers.has(info.id)).toBe(false);
    expect(sessionStore.remove).toHaveBeenCalledWith(info.id);
    expect(scrollbackBuffer.remove).toHaveBeenCalledWith(info.id);
    expect(fs.existsSync(statusFile(info.id))).toBe(false);
    expect(removed).toEqual([info.id]);
  });

  it('does not touch the PTY manager when the instance is already stopped', () => {
    const { manager, ptyManager, removed } = setup();
    const info = manager.launch({ cwd, name: 'test' });
    manager.kill(info.id);
    ptyManager.kill.mockClear();

    manager.dismiss(info.id);

    expect(ptyManager.kill).not.toHaveBeenCalled();
    expect(manager.get(info.id)).toBeUndefined();
    expect(removed).toEqual([info.id]);
  });

  it('runs project teardown commands before killing a live PTY', () => {
    fs.mkdirSync(path.join(cwd, '.mob'));
    fs.writeFileSync(path.join(cwd, '.mob', 'config.json'), JSON.stringify({ teardown: ['docker compose down'] }));
    const { manager, ptyManager } = setup();
    const info = manager.launch({ cwd, name: 'test' });

    manager.dismiss(info.id);

    expect(ptyManager.write).toHaveBeenCalledWith(info.id, 'docker compose down\r');
    expect(ptyManager.kill).not.toHaveBeenCalled();
    expect(manager.get(info.id)).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(ptyManager.kill).toHaveBeenCalledWith(info.id);
  });

  it('removes an external instance and its status file without a PTY', () => {
    const { manager, ptyManager, sessionStore, removed } = setup();
    manager.handleHookUpdate({
      id: 'ext-1', cwd, state: 'idle', hookEvent: 'SessionStart', lastUpdated: Date.now(), sessionId: 'sess-1',
    });
    fs.writeFileSync(statusFile('ext-1'), '{}');
    expect(manager.get('ext-1')?.managed).toBe(false);

    manager.dismiss('ext-1');

    expect(ptyManager.kill).not.toHaveBeenCalled();
    expect(manager.get('ext-1')).toBeUndefined();
    expect(sessionStore.remove).toHaveBeenCalledWith('ext-1');
    expect(fs.existsSync(statusFile('ext-1'))).toBe(false);
    expect(removed).toEqual(['ext-1']);
  });

  it('ignores a late PTY exit for a dismissed instance', () => {
    const { manager, ptyManager, sessionStore } = setup();
    const info = manager.launch({ cwd, name: 'test' });
    manager.dismiss(info.id);
    vi.mocked(sessionStore.save).mockClear();

    ptyManager.emit('exit', info.id, 0);

    expect(manager.get(info.id)).toBeUndefined();
    expect(sessionStore.save).not.toHaveBeenCalled();
  });
});
