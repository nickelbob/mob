import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { createWsServer, type WsServerHandle } from '../ws-server.js';
import { ScrollbackBuffer } from '../scrollback-buffer.js';
import type { InstanceManager } from '../instance-manager.js';
import type { IPtyManager } from '../pty-manager.js';
import type { ServerMessage } from '../../shared/protocol.js';

const A = 'inst-a';

class FakePty extends EventEmitter {
  write = vi.fn();
  resize = vi.fn();
}

class FakeInstanceManager extends EventEmitter {
  subscribers = new Map<string, Set<WebSocket>>();
  constructor(private scrollback: ScrollbackBuffer) { super(); }
  get(id: string) { return id === A ? { id } : undefined; }
  getAll() { return []; }
  getScrollback(id: string) { return this.scrollback.getBuffer(id); }
}

interface Client {
  ws: WebSocket;
  received: ServerMessage[];
  next(type: ServerMessage['type']): Promise<ServerMessage>;
  send(msg: object): void;
  /** Round-trips a sync so every message the server sent before it has arrived. */
  barrier(): Promise<void>;
  outputs(): string[];
}

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/mob-ws`);
  const received: ServerMessage[] = [];
  const waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    received.push(msg);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
  });
  const client: Client = {
    ws,
    received,
    next: (type) => new Promise((resolve) => waiters.push({ type, resolve })),
    send: (msg) => ws.send(JSON.stringify(msg)),
    barrier: async () => {
      const p = client.next('snapshot');
      client.send({ type: 'sync' });
      await p;
    },
    outputs: () => received
      .filter((m): m is Extract<ServerMessage, { type: 'terminal:output' }> => m.type === 'terminal:output')
      .map((m) => m.payload.data),
  };
  const snapshot = client.next('snapshot');
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await snapshot;
  return client;
}

describe('ws-server terminal subscribe/resize', () => {
  let server: Server;
  let handle: WsServerHandle;
  let pty: FakePty;
  let scrollback: ScrollbackBuffer;
  let port: number;
  const clients: Client[] = [];

  beforeEach(async () => {
    // Only the batch timer is faked so the 16 ms flush window stays open
    // until the test advances it; socket I/O is untouched.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scrollback = new ScrollbackBuffer();
    pty = new FakePty();
    pty.on('data', (id: string, data: string) => scrollback.append(id, data));
    const instanceManager = new FakeInstanceManager(scrollback);
    server = createServer();
    handle = createWsServer(server, instanceManager as unknown as InstanceManager, pty as unknown as IPtyManager);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const c of clients.splice(0)) c.ws.terminate();
    handle.wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function subscriber(): Promise<Client> {
    const c = await connect(port);
    clients.push(c);
    return c;
  }

  async function subscribe(c: Client): Promise<void> {
    const p = c.next('terminal:scrollback');
    c.send({ type: 'terminal:subscribe', payload: { instanceId: A } });
    await p;
  }

  it('output pending in the batch is flushed to existing subscribers before a new one gets the scrollback', async () => {
    pty.emit('data', A, 'seed');
    const c1 = await subscriber();
    await subscribe(c1);

    pty.emit('data', A, 'live');
    const c2 = await subscriber();
    await subscribe(c2);

    vi.advanceTimersByTime(20);
    await c1.barrier();
    await c2.barrier();

    expect(c1.outputs()).toEqual(['live']);
    expect(c2.outputs()).toEqual([]);
    const c2Scrollback = c2.received.find((m) => m.type === 'terminal:scrollback');
    expect(c2Scrollback?.payload).toEqual({ instanceId: A, data: 'seedlive' });
  });

  it('delivers batched output after the interval', async () => {
    pty.emit('data', A, 'seed');
    const c1 = await subscriber();
    await subscribe(c1);

    pty.emit('data', A, 'x');
    pty.emit('data', A, 'y');
    const out = c1.next('terminal:output');
    vi.advanceTimersByTime(16);
    expect((await out).payload).toEqual({ instanceId: A, data: 'xy' });
  });

  it('only the most recent subscriber may resize the PTY', async () => {
    pty.emit('data', A, 'seed');
    const c1 = await subscriber();
    const c2 = await subscriber();
    await subscribe(c1);
    await subscribe(c2);

    c1.send({ type: 'terminal:resize', payload: { instanceId: A, cols: 80, rows: 24 } });
    await c1.barrier();
    expect(pty.resize).not.toHaveBeenCalled();

    c2.send({ type: 'terminal:resize', payload: { instanceId: A, cols: 100, rows: 30 } });
    await c2.barrier();
    expect(pty.resize).toHaveBeenCalledWith(A, 100, 30);

    await subscribe(c1);
    c1.send({ type: 'terminal:resize', payload: { instanceId: A, cols: 80, rows: 24 } });
    await c1.barrier();
    expect(pty.resize).toHaveBeenCalledWith(A, 80, 24);
  });

  it('unsubscribing the active viewer promotes the previous one and asks it to resize', async () => {
    pty.emit('data', A, 'seed');
    const c1 = await subscriber();
    const c2 = await subscriber();
    await subscribe(c1);
    await subscribe(c2);

    const req = c1.next('terminal:resize-request');
    c2.send({ type: 'terminal:unsubscribe', payload: { instanceId: A } });
    expect((await req).payload).toEqual({ instanceId: A });

    c1.send({ type: 'terminal:resize', payload: { instanceId: A, cols: 80, rows: 24 } });
    await c1.barrier();
    expect(pty.resize).toHaveBeenCalledWith(A, 80, 24);
  });

  it('a disconnecting active viewer promotes the previous one', async () => {
    pty.emit('data', A, 'seed');
    const c1 = await subscriber();
    const c2 = await subscriber();
    await subscribe(c1);
    await subscribe(c2);

    const req = c1.next('terminal:resize-request');
    c2.ws.terminate();
    expect((await req).payload).toEqual({ instanceId: A });
  });

  it('a non-active viewer leaving promotes nobody', async () => {
    pty.emit('data', A, 'seed');
    const c1 = await subscriber();
    const c2 = await subscriber();
    await subscribe(c1);
    await subscribe(c2);

    c1.send({ type: 'terminal:unsubscribe', payload: { instanceId: A } });
    await c1.barrier();
    await c2.barrier();
    expect(c2.received.some((m) => m.type === 'terminal:resize-request')).toBe(false);
    expect(c1.received.some((m) => m.type === 'terminal:resize-request')).toBe(false);
  });
});
