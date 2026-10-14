import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const dirs = await vi.hoisted(async () => {
  const [{ default: fsMod }, { default: osMod }, { default: pathMod }] = await Promise.all([
    import('fs'), import('os'), import('path'),
  ]);
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mob-watcherr-'));
  return { root };
});

const warn = vi.fn();
vi.mock('../util/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn() }),
}));

vi.mock('../util/platform.js', () => ({
  getInstancesDir: () => dirs.root,
  ensureDir: () => {},
}));

// Stand-in for chokidar: a bare EventEmitter, so an unhandled 'error' event
// throws exactly as the real watcher's would.
class FakeWatcher extends EventEmitter {
  close = vi.fn();
}
const fake = new FakeWatcher();
vi.mock('chokidar', () => ({
  default: { watch: () => fake },
}));

import { DiscoveryService } from '../discovery.js';

describe('DiscoveryService watcher errors', () => {
  afterEach(() => {
    fake.removeAllListeners();
    warn.mockClear();
  });

  it('swallows an EPERM stat failure instead of crashing the process', () => {
    const svc = new DiscoveryService();
    svc.start();

    const eperm = Object.assign(new Error("EPERM: operation not permitted, stat 'x.json'"), { code: 'EPERM' });
    // Unhandled, this is the uncaughtException that took the worker down.
    expect(() => fake.emit('error', eperm)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('EPERM');
  });

  it('keeps serving file events after an error', () => {
    const svc = new DiscoveryService();
    svc.start();
    const updates: unknown[] = [];
    svc.on('update', (s) => updates.push(s));

    fake.emit('error', Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    // A real status file write re-fires change; the service must still be live.
    expect(() => fake.emit('change', 'not-a-status-file.txt')).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('registers an error listener at all', () => {
    const svc = new DiscoveryService();
    svc.start();
    expect(fake.listenerCount('error')).toBeGreaterThan(0);
  });
});
