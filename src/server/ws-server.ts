import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { InstanceManager } from './instance-manager.js';
import type { PtyManager } from './pty-manager.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { validateLaunchPayload } from './util/sanitize.js';
import { createLogger } from './util/logger.js';
import { performUpdate } from './update-checker.js';

const log = createLogger('ws');

export interface WsServerHandle {
  wss: WebSocketServer;
  setUpdateInfo(info: { current: string; latest: string } | null): void;
  onUpdateRestart(callback: () => void): void;
}

export function createWsServer(
  server: Server,
  instanceManager: InstanceManager,
  ptyManager: PtyManager,
): WsServerHandle {
  const wss = new WebSocketServer({
    server,
    path: '/mob-ws',
    verifyClient: ({ origin }: { origin: string }) => {
      if (!origin) return true; // non-browser clients (CLI, curl, etc.)
      try {
        const url = new URL(origin);
        return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      } catch {
        return false;
      }
    },
  });
  let clientCount = 0;
  let updateInfo: { current: string; latest: string } | null = null;
  let restartCallback: (() => void) | null = null;
  let isUpdating = false;

  log.info( 'WebSocket server created on path /mob-ws');

  function broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    let sent = 0;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
        sent++;
      }
    }
    if (msg.type !== 'terminal:output') {
      log.info( `Broadcast ${msg.type} to ${sent} client(s)`);
    }
  }

  // Forward instance events to all clients
  instanceManager.on('update', (info) => {
    log.info( `Instance update: ${info.id} (${info.name}) state=${info.state}`);
    broadcast({ type: 'instance:update', payload: info });
  });

  instanceManager.on('remove', (id) => {
    log.info( `Instance removed: ${id}`);
    broadcast({ type: 'instance:remove', payload: { instanceId: id } });
  });

  // Forward PTY data to subscribed clients
  ptyManager.on('data', (instanceId: string, data: string) => {
    const subs = instanceManager.subscribers.get(instanceId);
    if (subs) {
      const msg = JSON.stringify({
        type: 'terminal:output',
        payload: { instanceId, data },
      } satisfies ServerMessage);
      for (const client of subs) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    }
  });

  instanceManager.on('pty:exit', (instanceId: string, exitCode: number) => {
    log.info( `PTY exit: ${instanceId} code=${exitCode}`);
    const subs = instanceManager.subscribers.get(instanceId);
    if (subs) {
      const msg = JSON.stringify({
        type: 'terminal:exit',
        payload: { instanceId, exitCode },
      } satisfies ServerMessage);
      for (const client of subs) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    }
  });

  wss.on('connection', (ws, req) => {
    clientCount++;
    const clientId = clientCount;
    log.info( `Client #${clientId} connected from ${req.socket.remoteAddress}`);

    // Send current snapshot
    const snapshot = instanceManager.getAll();
    log.info( `Sending snapshot to #${clientId}: ${snapshot.length} instance(s)`);
    ws.send(JSON.stringify({
      type: 'snapshot',
      payload: { instances: snapshot, ...(updateInfo ? { updateAvailable: updateInfo } : {}) },
    } satisfies ServerMessage));

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        log.error( `Client #${clientId}: invalid JSON`);
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON' } }));
        return;
      }

      log.info( `Client #${clientId} → ${msg.type}`, msg.type === 'terminal:input' ? '(input data)' : ('payload' in msg ? (msg as any).payload : ''));

      switch (msg.type) {
        case 'sync':
          ws.send(JSON.stringify({
            type: 'snapshot',
            payload: { instances: instanceManager.getAll(), ...(updateInfo ? { updateAvailable: updateInfo } : {}) },
          } satisfies ServerMessage));
          break;

        case 'launch': {
          const validation = validateLaunchPayload(msg.payload);
          if (!validation.valid) {
            log.warn( `Client #${clientId} launch rejected: ${validation.error}`);
            ws.send(JSON.stringify({
              type: 'error',
              payload: { message: validation.error },
            }));
            break;
          }
          log.info( `Client #${clientId} launching: cwd=${validation.data.cwd} name=${validation.data.name || '(auto)'}`);
          const info = instanceManager.launch(validation.data);
          log.info( `Launched instance ${info.id} (${info.name})`);
          // Auto-subscribe the launching client
          const subs = instanceManager.subscribers.get(info.id);
          if (subs) subs.add(ws);
          // Tell the launching client to select this instance
          ws.send(JSON.stringify({
            type: 'instance:select',
            payload: { instanceId: info.id },
          } satisfies ServerMessage));
          break;
        }

        case 'kill':
          log.info( `Client #${clientId} killing instance ${msg.payload.instanceId}`);
          instanceManager.kill(msg.payload.instanceId);
          break;

        case 'resume': {
          log.info( `Client #${clientId} resuming instance ${msg.payload.instanceId}`);
          const resumed = instanceManager.resume(msg.payload.instanceId);
          if (resumed) {
            log.info( `Resumed as new instance ${resumed.id}`);
            const subs = instanceManager.subscribers.get(resumed.id);
            if (subs) subs.add(ws);
            ws.send(JSON.stringify({
              type: 'instance:select',
              payload: { instanceId: resumed.id },
            } satisfies ServerMessage));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              payload: { message: 'Cannot resume instance', context: msg.payload.instanceId },
            }));
          }
          break;
        }

        case 'dismiss':
          log.info( `Client #${clientId} dismissing instance ${msg.payload.instanceId}`);
          instanceManager.dismiss(msg.payload.instanceId);
          break;

        case 'terminal:subscribe': {
          const { instanceId } = msg.payload;
          log.info( `Client #${clientId} subscribing to ${instanceId}`);
          // Only allow subscribing to existing instances
          if (!instanceManager.get(instanceId)) {
            log.warn( `Client #${clientId} tried to subscribe to non-existent instance ${instanceId}`);
            break;
          }
          let subs = instanceManager.subscribers.get(instanceId);
          if (!subs) {
            subs = new Set();
            instanceManager.subscribers.set(instanceId, subs);
          }
          subs.add(ws);

          // Send scrollback history
          const scrollback = instanceManager.getScrollback(instanceId);
          if (scrollback) {
            ws.send(JSON.stringify({
              type: 'terminal:scrollback',
              payload: { instanceId, data: scrollback },
            } satisfies ServerMessage));
          }
          break;
        }

        case 'terminal:unsubscribe': {
          const { instanceId } = msg.payload;
          instanceManager.subscribers.get(instanceId)?.delete(ws);
          break;
        }

        case 'terminal:input':
          ptyManager.write(msg.payload.instanceId, msg.payload.data);
          break;

        case 'terminal:resize':
          ptyManager.resize(
            msg.payload.instanceId,
            msg.payload.cols,
            msg.payload.rows,
          );
          break;

        case 'update:install': {
          if (isUpdating) {
            ws.send(JSON.stringify({
              type: 'error',
              payload: { message: 'Update already in progress' },
            }));
            break;
          }
          if (!updateInfo) {
            ws.send(JSON.stringify({
              type: 'error',
              payload: { message: 'No update available' },
            }));
            break;
          }
          isUpdating = true;
          log.info(`Client #${clientId} triggered update to ${updateInfo.latest}`);
          broadcast({ type: 'update:status', payload: { status: 'installing' } });
          const result = performUpdate(updateInfo.latest);
          if (result.success) {
            broadcast({ type: 'update:status', payload: { status: 'success' } });
            // Give clients a moment to receive the success message before restarting
            setTimeout(() => {
              if (restartCallback) restartCallback();
            }, 1000);
          } else {
            isUpdating = false;
            broadcast({ type: 'update:status', payload: { status: 'failed', error: result.error } });
          }
          break;
        }

        default:
          log.warn( `Client #${clientId}: unknown message type`);
          ws.send(JSON.stringify({
            type: 'error',
            payload: { message: `Unknown message type` },
          }));
      }
    });

    ws.on('close', (code, reason) => {
      log.info( `Client #${clientId} disconnected (code=${code})`);
      for (const subs of instanceManager.subscribers.values()) {
        subs.delete(ws);
      }
    });

    ws.on('error', (err) => {
      log.error( `Client #${clientId} error:`, err.message);
    });
  });

  return {
    wss,
    setUpdateInfo(info: { current: string; latest: string } | null) {
      updateInfo = info;
    },
    onUpdateRestart(callback: () => void) {
      restartCallback = callback;
    },
  };
}
