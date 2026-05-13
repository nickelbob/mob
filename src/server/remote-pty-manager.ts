/**
 * IPC client that mirrors the PtyManager API but forwards all operations
 * to a separate supervisor process. Used by the dev server worker so PTYs
 * survive when the worker restarts on code changes.
 */
import { EventEmitter } from 'events';
import net from 'net';
import { getSupervisorSocketPath } from './util/supervisor-paths.js';
import { createLogger } from './util/logger.js';
import type { WorkerRequest, SupervisorEvent, SupervisorSpawnOpts } from './supervisor-protocol.js';
import type { IPtyManager } from './pty-manager.js';

const log = createLogger('remote-pty');

const CONNECT_TIMEOUT_MS = 1000;
const CONNECT_MAX_RETRIES = 20; // ~20 seconds total
const CONNECT_RETRY_DELAY_MS = 1000;
const RECONNECT_DELAY_MS = 1000;
const LIST_TIMEOUT_MS = 2000;

export class RemotePtyManager extends EventEmitter implements IPtyManager {
  private socket: net.Socket | null = null;
  private connected = false;
  private buffer = '';
  private knownIds = new Set<string>();
  private pendingList: ((ids: string[]) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrites: string[] = [];
  private socketPath: string;

  constructor(port: number) {
    super();
    this.socketPath = getSupervisorSocketPath(port);
  }

  /**
   * Connect to the supervisor with retry. Used during startup when the
   * supervisor may not yet be listening.
   */
  async connect(): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= CONNECT_MAX_RETRIES; attempt++) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === 1 || attempt % 5 === 0) {
          log.info(`waiting for supervisor at ${this.socketPath} (attempt ${attempt}/${CONNECT_MAX_RETRIES})`);
        }
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
      }
    }
    throw new Error(`Could not connect to supervisor at ${this.socketPath}: ${lastErr}`);
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('connect timeout'));
        this.socket?.destroy();
      }, CONNECT_TIMEOUT_MS);

      this.socket = net.createConnection(this.socketPath, () => {
        clearTimeout(timeout);
        this.connected = true;
        log.info(`connected to supervisor at ${this.socketPath}`);
        for (const line of this.pendingWrites) {
          this.socket?.write(line);
        }
        this.pendingWrites = [];
        resolve();
      });

      this.socket.on('data', (chunk: Buffer) => this.handleData(chunk));
      this.socket.on('close', () => {
        if (this.connected) {
          log.warn('supervisor disconnected; will retry');
        }
        this.connected = false;
        this.scheduleReconnect();
      });
      this.socket.on('error', (err: Error) => {
        if (!this.connected) {
          clearTimeout(timeout);
          reject(err);
        } else {
          log.warn(`socket error: ${err.message}`);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, RECONNECT_DELAY_MS);
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let event: SupervisorEvent;
      try { event = JSON.parse(line); } catch {
        log.warn(`malformed event: ${line.slice(0, 100)}`);
        continue;
      }
      this.handleEvent(event);
    }
  }

  private handleEvent(event: SupervisorEvent): void {
    switch (event.type) {
      case 'data':
        this.knownIds.add(event.id);
        this.emit('data', event.id, event.data);
        break;
      case 'exit':
        this.knownIds.delete(event.id);
        this.emit('exit', event.id, event.exitCode);
        break;
      case 'error':
        this.emit('error', event.id, new Error(event.error));
        break;
      case 'list':
        this.knownIds = new Set(event.ids);
        if (this.pendingList) {
          this.pendingList(event.ids);
          this.pendingList = null;
        }
        break;
    }
  }

  private send(req: WorkerRequest): void {
    const line = JSON.stringify(req) + '\n';
    if (this.socket && this.connected) {
      this.socket.write(line);
    } else {
      // Queue until connected (in case of brief reconnect window)
      this.pendingWrites.push(line);
    }
  }

  /** Query the supervisor for currently live PTY IDs. */
  async listExisting(): Promise<string[]> {
    return new Promise((resolve) => {
      if (!this.connected) {
        resolve([]);
        return;
      }
      this.pendingList = resolve;
      this.send({ type: 'list' });
      setTimeout(() => {
        if (this.pendingList === resolve) {
          this.pendingList = null;
          resolve(Array.from(this.knownIds));
        }
      }, LIST_TIMEOUT_MS);
    });
  }

  // --- PtyManager API mirror ---

  spawn(instanceId: string, cwd: string, opts?: SupervisorSpawnOpts): void {
    this.knownIds.add(instanceId);
    this.send({ type: 'spawn', id: instanceId, cwd, opts });
  }

  write(instanceId: string, data: string): void {
    this.send({ type: 'write', id: instanceId, data });
  }

  resize(instanceId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', id: instanceId, cols, rows });
  }

  kill(instanceId: string): void {
    this.knownIds.delete(instanceId);
    this.send({ type: 'kill', id: instanceId });
  }

  has(instanceId: string): boolean {
    return this.knownIds.has(instanceId);
  }

  getAll(): Map<string, null> {
    const map = new Map<string, null>();
    for (const id of this.knownIds) map.set(id, null);
    return map;
  }
}
