import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}
}

async function createClient() {
  const { WsClient } = await import('../lib/ws-client.js');
  const client = new WsClient('ws://test/mob-ws');
  client.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  return { client, socket };
}

describe('WsClient message dispatch', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:4040' });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('still runs later handlers when an earlier one throws', async () => {
    const { client, socket } = await createClient();
    const later = vi.fn();
    client.onMessage(() => {
      throw new Error('boom');
    });
    client.onMessage(later);

    const msg = { type: 'terminal:output', payload: { instanceId: 'a', data: 'x' } };
    socket.onmessage!({ data: JSON.stringify(msg) });

    expect(later).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledWith(msg);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0].join(' ')).toContain('Handler #0 threw on "terminal:output"');
  });

  it('invokes handlers in registration order', async () => {
    const { client, socket } = await createClient();
    const order: string[] = [];
    client.onMessage(() => order.push('first'));
    client.onMessage(() => {
      order.push('second');
      throw new Error('boom');
    });
    client.onMessage(() => order.push('third'));

    socket.onmessage!({ data: JSON.stringify({ type: 'instance:select', payload: { instanceId: 'a' } }) });

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('logs a parse failure without invoking any handler', async () => {
    const { client, socket } = await createClient();
    const handler = vi.fn();
    client.onMessage(handler);

    socket.onmessage!({ data: '{not json' });

    expect(handler).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0].join(' ')).toContain('Failed to parse message');
  });

  it('stops delivering to a handler after its unsubscribe', async () => {
    const { client, socket } = await createClient();
    const handler = vi.fn();
    const unsub = client.onMessage(handler);
    unsub();

    socket.onmessage!({ data: JSON.stringify({ type: 'instance:select', payload: { instanceId: 'a' } }) });

    expect(handler).not.toHaveBeenCalled();
  });
});
