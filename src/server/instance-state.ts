import type { InstanceState } from '../shared/protocol.js';
import { HOOK_SILENCE_THRESHOLD_MS } from '../shared/constants.js';

/**
 * Single reducer for instance state transitions.
 *
 * Instance state used to be mutated from three uncoordinated places — hook
 * updates, the terminal-state detector, and the stale-check timer — which
 * made the effective precedence emergent and timing-dependent (visible as
 * running→idle→running flapping mid-task). All transitions now flow through
 * `reduce`, which encodes the precedence explicitly:
 *
 *   pty exit / lifecycle  >  hooks (when fresh)  >  terminal detection
 *
 * Terminal-derived demotions are additionally debounced: the evidence must
 * hold for HYSTERESIS_TICKS consecutive stale-check ticks before the state
 * flips, so a spinner momentarily scrolling out of the scan window can't
 * blink the state.
 */

export const HYSTERESIS_TICKS = 2;

export interface StateContext {
  state: InstanceState;
  /** Timestamp of the last hook-sourced state update, if any. */
  lastHookUpdate?: number;
  /** Consecutive terminal ticks that have argued for a demotion. */
  pendingIdleTicks: number;
}

export type StateEvent =
  /** A Claude Code hook reported a state (authoritative when fresh). */
  | { source: 'hook'; state: InstanceState; at: number }
  /** One stale-check tick's terminal-detection result. */
  | { source: 'terminal'; detected: InstanceState; hasIdleMarker: boolean; at: number }
  /** The PTY process exited or was found dead. */
  | { source: 'pty'; kind: 'exited'; at: number }
  /** Server-driven lifecycle transitions. */
  | { source: 'lifecycle'; kind: 'launch-timeout' | 'kill' | 'spawn-failed' | 'adopt'; at: number };

export function reduce(ctx: StateContext, ev: StateEvent): StateContext {
  switch (ev.source) {
    case 'pty':
      return { ...ctx, state: 'stopped', pendingIdleTicks: 0 };

    case 'lifecycle':
      switch (ev.kind) {
        case 'launch-timeout':
          // Only meaningful if nothing else moved the state since launch.
          return ctx.state === 'launching'
            ? { ...ctx, state: 'idle', pendingIdleTicks: 0 }
            : ctx;
        case 'kill':
        case 'spawn-failed':
          return { ...ctx, state: 'stopped', pendingIdleTicks: 0 };
        case 'adopt':
          // Adopted after a server restart: idle is the safe default; a
          // terminal event follows immediately to correct it if Claude is
          // mid-task (see loadPreviousSessions).
          return { ...ctx, state: 'idle', pendingIdleTicks: 0 };
      }
      return ctx;

    case 'hook':
      // Hooks are authoritative. Callers filter out the known-bad cases
      // (SessionEnd from a subtask while the parent PTY is alive) before
      // submitting the event.
      return { state: ev.state, lastHookUpdate: ev.at, pendingIdleTicks: 0 };

    case 'terminal': {
      const hookFresh =
        ctx.lastHookUpdate !== undefined &&
        ev.at - ctx.lastHookUpdate < HOOK_SILENCE_THRESHOLD_MS;

      switch (ctx.state) {
        case 'stopped':
        case 'launching':
          // Terminal evidence never resurrects a stopped instance, and the
          // launch-timeout owns the launching→idle transition.
          return ctx.pendingIdleTicks === 0 ? ctx : { ...ctx, pendingIdleTicks: 0 };

        case 'running':
          // Demote running→idle only on positive evidence (mode footer with
          // no "esc to interrupt"), or on any idle reading once hooks have
          // gone silent — and only after it holds for consecutive ticks.
          if (ev.detected === 'idle' && (ev.hasIdleMarker || !hookFresh)) {
            const ticks = ctx.pendingIdleTicks + 1;
            return ticks >= HYSTERESIS_TICKS
              ? { ...ctx, state: 'idle', pendingIdleTicks: 0 }
              : { ...ctx, pendingIdleTicks: ticks };
          }
          if (!hookFresh && ev.detected === 'waiting') {
            return { ...ctx, state: 'waiting', pendingIdleTicks: 0 };
          }
          return ctx.pendingIdleTicks === 0 ? ctx : { ...ctx, pendingIdleTicks: 0 };

        case 'idle':
          // Promote as soon as hooks are silent and the terminal shows
          // activity or a permission prompt.
          if (!hookFresh && ev.detected !== 'idle') {
            return { ...ctx, state: ev.detected, pendingIdleTicks: 0 };
          }
          return ctx.pendingIdleTicks === 0 ? ctx : { ...ctx, pendingIdleTicks: 0 };

        case 'waiting':
          // 'waiting' is hook-authoritative, but must not be a trap: if the
          // user answered in the terminal and the resolving hook was missed,
          // recover once hooks are silent — to running on the canonical
          // "esc to interrupt", or to idle on a sustained mode footer.
          if (!hookFresh && ev.detected === 'running') {
            return { ...ctx, state: 'running', pendingIdleTicks: 0 };
          }
          if (!hookFresh && ev.detected === 'idle' && ev.hasIdleMarker) {
            const ticks = ctx.pendingIdleTicks + 1;
            return ticks >= HYSTERESIS_TICKS
              ? { ...ctx, state: 'idle', pendingIdleTicks: 0 }
              : { ...ctx, pendingIdleTicks: ticks };
          }
          return ctx.pendingIdleTicks === 0 ? ctx : { ...ctx, pendingIdleTicks: 0 };
      }
      return ctx;
    }
  }
}
