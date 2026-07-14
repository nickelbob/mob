import { describe, it, expect } from 'vitest';
import { reduce, HYSTERESIS_TICKS, type StateContext } from '../instance-state.js';
import { HOOK_SILENCE_THRESHOLD_MS } from '../../shared/constants.js';

const T0 = 1_000_000;
const FRESH = T0 + 1_000; // within hook-silence threshold of a hook at T0
const SILENT = T0 + HOOK_SILENCE_THRESHOLD_MS + 1_000;

function ctx(partial: Partial<StateContext>): StateContext {
  return { state: 'idle', pendingIdleTicks: 0, ...partial };
}

describe('instance-state reducer', () => {
  describe('hook events', () => {
    it('applies the hook state and stamps lastHookUpdate', () => {
      const next = reduce(ctx({ state: 'idle' }), { source: 'hook', state: 'running', at: T0 });
      expect(next.state).toBe('running');
      expect(next.lastHookUpdate).toBe(T0);
    });

    it('resets pending demote ticks', () => {
      const next = reduce(ctx({ state: 'running', pendingIdleTicks: 1 }), { source: 'hook', state: 'running', at: T0 });
      expect(next.pendingIdleTicks).toBe(0);
    });
  });

  describe('pty / lifecycle events', () => {
    it('pty exit always wins, even over a fresh hook', () => {
      const next = reduce(
        ctx({ state: 'running', lastHookUpdate: T0 }),
        { source: 'pty', kind: 'exited', at: FRESH },
      );
      expect(next.state).toBe('stopped');
    });

    it('launch-timeout moves launching to idle', () => {
      const next = reduce(ctx({ state: 'launching' }), { source: 'lifecycle', kind: 'launch-timeout', at: T0 });
      expect(next.state).toBe('idle');
    });

    it('launch-timeout is a no-op when something else already moved the state', () => {
      const next = reduce(ctx({ state: 'running' }), { source: 'lifecycle', kind: 'launch-timeout', at: T0 });
      expect(next.state).toBe('running');
    });

    it('kill and spawn-failed stop the instance', () => {
      expect(reduce(ctx({ state: 'running' }), { source: 'lifecycle', kind: 'kill', at: T0 }).state).toBe('stopped');
      expect(reduce(ctx({ state: 'launching' }), { source: 'lifecycle', kind: 'spawn-failed', at: T0 }).state).toBe('stopped');
    });

    it('adopt starts at idle', () => {
      expect(reduce(ctx({ state: 'running' }), { source: 'lifecycle', kind: 'adopt', at: T0 }).state).toBe('idle');
    });
  });

  describe('terminal demotion hysteresis (running → idle)', () => {
    it('a single idle reading mid-task does NOT demote (the flapping bug)', () => {
      // Hooks are fresh (Claude is mid-task); the spinner scrolled out of the
      // scan window for one tick while the mode footer is visible.
      const next = reduce(
        ctx({ state: 'running', lastHookUpdate: T0 }),
        { source: 'terminal', detected: 'idle', hasIdleMarker: true, at: FRESH },
      );
      expect(next.state).toBe('running');
      expect(next.pendingIdleTicks).toBe(1);
    });

    it('demotes after the evidence holds for consecutive ticks', () => {
      let c = ctx({ state: 'running', lastHookUpdate: T0 });
      for (let i = 0; i < HYSTERESIS_TICKS - 1; i++) {
        c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: true, at: FRESH + i });
        expect(c.state).toBe('running');
      }
      c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: true, at: FRESH + HYSTERESIS_TICKS });
      expect(c.state).toBe('idle');
      expect(c.pendingIdleTicks).toBe(0);
    });

    it('a running reading in between resets the streak', () => {
      let c = ctx({ state: 'running', lastHookUpdate: T0 });
      c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: true, at: FRESH });
      expect(c.pendingIdleTicks).toBe(1);
      c = reduce(c, { source: 'terminal', detected: 'running', hasIdleMarker: false, at: FRESH + 1 });
      expect(c.pendingIdleTicks).toBe(0);
      expect(c.state).toBe('running');
    });

    it('without an idle marker, demotion requires hook silence', () => {
      // Fresh hooks + no positive marker (e.g. alternate-screen tool): stay running.
      let c = ctx({ state: 'running', lastHookUpdate: T0 });
      c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: false, at: FRESH });
      c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: false, at: FRESH + 1 });
      expect(c.state).toBe('running');

      // Hooks silent: same evidence demotes (after hysteresis).
      let s = ctx({ state: 'running', lastHookUpdate: T0 });
      s = reduce(s, { source: 'terminal', detected: 'idle', hasIdleMarker: false, at: SILENT });
      expect(s.state).toBe('running');
      s = reduce(s, { source: 'terminal', detected: 'idle', hasIdleMarker: false, at: SILENT + 1 });
      expect(s.state).toBe('idle');
    });
  });

  describe('hooks win over terminal detection when fresh', () => {
    it('idle stays idle on terminal activity while hooks are fresh', () => {
      const next = reduce(
        ctx({ state: 'idle', lastHookUpdate: T0 }),
        { source: 'terminal', detected: 'running', hasIdleMarker: false, at: FRESH },
      );
      expect(next.state).toBe('idle');
    });

    it('idle promotes to running once hooks are silent', () => {
      const next = reduce(
        ctx({ state: 'idle', lastHookUpdate: T0 }),
        { source: 'terminal', detected: 'running', hasIdleMarker: false, at: SILENT },
      );
      expect(next.state).toBe('running');
    });

    it('idle promotes immediately when no hook has ever fired', () => {
      const next = reduce(
        ctx({ state: 'idle' }),
        { source: 'terminal', detected: 'running', hasIdleMarker: false, at: T0 },
      );
      expect(next.state).toBe('running');
    });
  });

  describe('stuck-waiting recovery', () => {
    it('waiting is not left while hooks are fresh', () => {
      const next = reduce(
        ctx({ state: 'waiting', lastHookUpdate: T0 }),
        { source: 'terminal', detected: 'idle', hasIdleMarker: true, at: FRESH },
      );
      expect(next.state).toBe('waiting');
      expect(next.pendingIdleTicks).toBe(0);
    });

    it('waiting recovers to running on esc-to-interrupt once hooks are silent', () => {
      const next = reduce(
        ctx({ state: 'waiting', lastHookUpdate: T0 }),
        { source: 'terminal', detected: 'running', hasIdleMarker: false, at: SILENT },
      );
      expect(next.state).toBe('running');
    });

    it('waiting recovers to idle on a sustained mode footer once hooks are silent', () => {
      let c = ctx({ state: 'waiting', lastHookUpdate: T0 });
      c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: true, at: SILENT });
      expect(c.state).toBe('waiting');
      c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: true, at: SILENT + 1 });
      expect(c.state).toBe('idle');
    });

    it('waiting does not recover to idle without a positive marker', () => {
      let c = ctx({ state: 'waiting', lastHookUpdate: T0 });
      c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: false, at: SILENT });
      c = reduce(c, { source: 'terminal', detected: 'idle', hasIdleMarker: false, at: SILENT + 1 });
      expect(c.state).toBe('waiting');
    });
  });

  describe('terminal events never touch stopped/launching', () => {
    it('stopped is never resurrected by terminal evidence', () => {
      const next = reduce(
        ctx({ state: 'stopped' }),
        { source: 'terminal', detected: 'running', hasIdleMarker: false, at: SILENT },
      );
      expect(next.state).toBe('stopped');
    });

    it('launching is owned by the launch-timeout, not terminal detection', () => {
      const next = reduce(
        ctx({ state: 'launching' }),
        { source: 'terminal', detected: 'idle', hasIdleMarker: true, at: T0 },
      );
      expect(next.state).toBe('launching');
    });
  });
});
