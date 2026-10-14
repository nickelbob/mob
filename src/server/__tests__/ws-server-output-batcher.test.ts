import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { WebSocket } from 'ws';
import {
  createOutputBatcher,
  activeViewer,
  addViewer,
  removeViewer,
  type OutputSink,
} from '../ws-server.js';

type FakeSink = OutputSink & { send: Mock<(data: string) => void> };

function sink(overrides: Partial<Pick<OutputSink, 'readyState' | 'bufferedAmount'>> = {}): FakeSink {
  return { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn<(data: string) => void>(), ...overrides };
}

function sentData(s: FakeSink): string[] {
  return s.send.mock.calls.map(([raw]) => JSON.parse(raw as string).payload.data);
}

describe('createOutputBatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces pushes within the batch interval into one message', () => {
    const a = sink();
    const subs = new Map([['x', new Set<OutputSink>([a])]]);
    const batcher = createOutputBatcher((id) => subs.get(id));

    batcher.push('x', 'hel');
    batcher.push('x', 'lo');
    expect(a.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(sentData(a)).toEqual(['hello']);
    expect(JSON.parse(a.send.mock.calls[0][0] as string)).toEqual({
      type: 'terminal:output',
      payload: { instanceId: 'x', data: 'hello' },
    });
  });

  it('flushNow sends immediately and cancels the pending timer', () => {
    const a = sink();
    const batcher = createOutputBatcher(() => new Set<OutputSink>([a]));

    batcher.push('x', 'live');
    batcher.flushNow('x');
    expect(sentData(a)).toEqual(['live']);

    vi.advanceTimersByTime(50);
    expect(sentData(a)).toEqual(['live']);
  });

  it('flushNow goes only to subscribers present at the time of the call', () => {
    const a = sink();
    const b = sink();
    const set = new Set<OutputSink>([a]);
    const batcher = createOutputBatcher(() => set);

    batcher.push('x', 'live');
    batcher.flushNow('x');
    set.add(b);
    vi.advanceTimersByTime(50);

    expect(sentData(a)).toEqual(['live']);
    expect(sentData(b)).toEqual([]);
  });

  it('flushNow with no subscribers drops the buffer', () => {
    const a = sink();
    const set = new Set<OutputSink>();
    const batcher = createOutputBatcher(() => set);

    batcher.push('x', 'orphan');
    batcher.flushNow('x');
    set.add(a);
    vi.advanceTimersByTime(50);

    expect(sentData(a)).toEqual([]);
  });

  it('scheduled flush defers while a subscriber is backpressured; flushNow does not', () => {
    const stuck = sink({ bufferedAmount: 8 * 1024 * 1024 });
    const batcher = createOutputBatcher(() => new Set<OutputSink>([stuck]));

    batcher.push('x', 'data');
    vi.advanceTimersByTime(16);
    expect(stuck.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(stuck.send).not.toHaveBeenCalled();

    batcher.flushNow('x');
    expect(sentData(stuck)).toEqual(['data']);
  });

  it('skips sockets that are not open', () => {
    const open = sink();
    const closed = sink({ readyState: WebSocket.CLOSED });
    const batcher = createOutputBatcher(() => new Set<OutputSink>([open, closed]));

    batcher.push('x', 'data');
    vi.advanceTimersByTime(16);
    expect(sentData(open)).toEqual(['data']);
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('drop discards the buffer and the pending timer', () => {
    const a = sink();
    const batcher = createOutputBatcher(() => new Set<OutputSink>([a]));

    batcher.push('x', 'data');
    batcher.drop('x');
    vi.advanceTimersByTime(50);
    expect(a.send).not.toHaveBeenCalled();
  });

  it('keeps instances independent', () => {
    const a = sink();
    const b = sink();
    const subs = new Map([['x', new Set<OutputSink>([a])], ['y', new Set<OutputSink>([b])]]);
    const batcher = createOutputBatcher((id) => subs.get(id));

    batcher.push('x', 'for-x');
    batcher.push('y', 'for-y');
    batcher.flushNow('x');
    expect(sentData(a)).toEqual(['for-x']);
    expect(b.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(sentData(a)).toEqual(['for-x']);
    expect(sentData(b)).toEqual(['for-y']);
  });
});

describe('active viewer selection', () => {
  it('activeViewer is the most recently added subscriber', () => {
    expect(activeViewer(undefined)).toBeUndefined();
    expect(activeViewer(new Set())).toBeUndefined();

    const subs = new Set<string>();
    addViewer(subs, 'a');
    addViewer(subs, 'b');
    expect(activeViewer(subs)).toBe('b');
  });

  it('re-adding an existing subscriber makes it active again', () => {
    const subs = new Set<string>();
    addViewer(subs, 'a');
    addViewer(subs, 'b');
    addViewer(subs, 'a');
    expect(activeViewer(subs)).toBe('a');
    expect([...subs]).toEqual(['b', 'a']);
  });

  it('removing the active viewer promotes the most recent remaining one', () => {
    const subs = new Set<string>();
    addViewer(subs, 'a');
    addViewer(subs, 'b');
    addViewer(subs, 'c');
    expect(removeViewer(subs, 'c')).toBe('b');
    expect(activeViewer(subs)).toBe('b');
  });

  it('removing a non-active viewer promotes nobody', () => {
    const subs = new Set<string>();
    addViewer(subs, 'a');
    addViewer(subs, 'b');
    expect(removeViewer(subs, 'a')).toBeUndefined();
    expect(activeViewer(subs)).toBe('b');
  });

  it('removing the last viewer promotes nobody', () => {
    const subs = new Set<string>(['a']);
    expect(removeViewer(subs, 'a')).toBeUndefined();
    expect(subs.size).toBe(0);
  });

  it('removing an unknown viewer is a no-op', () => {
    const subs = new Set<string>(['a']);
    expect(removeViewer(subs, 'zzz')).toBeUndefined();
    expect(removeViewer(undefined, 'a')).toBeUndefined();
    expect([...subs]).toEqual(['a']);
  });
});
