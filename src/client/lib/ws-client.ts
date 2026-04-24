import type { ClientMessage, ServerMessage } from './types.js';

type MessageHandler = (msg: ServerMessage) => void;

function log(level: 'info' | 'warn' | 'error', ...args: unknown[]) {
  const prefix = `%c[mob-ws]`;
  const style = level === 'error' ? 'color:#f85149' : level === 'warn' ? 'color:#d29922' : 'color:#58a6ff';
  console[level](prefix, style, ...args);
}

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers = new Set<MessageHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 10000;
  private _connected = false;
  private onConnectionChange: ((connected: boolean) => void) | null = null;

  constructor(url?: string) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url || `${protocol}//${location.host}/mob-ws`;
    log('info', `URL: ${this.url}`);
  }

  connect(): void {
    log('info', `Connecting to ${this.url}...`);
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      log('error', 'Failed to create WebSocket:', e);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      log('info', 'Connected');
      this._connected = true;
      this.reconnectDelay = 1000;
      this.onConnectionChange?.(true);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        if (msg.type !== 'terminal:output' && msg.type !== 'terminal:scrollback') {
          log('info', `← ${msg.type}`, msg.payload);
        }
        for (const handler of this.handlers) {
          handler(msg);
        }
      } catch (e) {
        log('error', 'Failed to parse message:', e, event.data);
      }
    };

    this.ws.onclose = (event) => {
      log('warn', `Disconnected (code=${event.code}, reason=${event.reason || 'none'})`);
      this._connected = false;
      this.onConnectionChange?.(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = (event) => {
      log('error', 'WebSocket error:', event);
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    log('info', `Reconnecting in ${Math.round(this.reconnectDelay)}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (msg.type !== 'terminal:input') {
        log('info', `→ ${msg.type}`, 'payload' in msg ? (msg as any).payload : '');
      }
      this.ws.send(JSON.stringify(msg));
    } else {
      log('warn', `Cannot send "${msg.type}" — not connected (readyState=${this.ws?.readyState})`);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  setConnectionHandler(handler: (connected: boolean) => void): void {
    this.onConnectionChange = handler;
  }

  get connected(): boolean {
    return this._connected;
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}
