import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { InstanceManager } from './instance-manager.js';
import type { IPtyManager } from './pty-manager.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { validateLaunchPayload, validateEditPayload } from './util/sanitize.js';
import { createLogger } from './util/logger.js';
import { performUpdate, getVersion, checkForUpdate, clearUpdateCache } from './update-checker.js';

const log = createLogger('ws');

/** Message types whose payload must carry a valid instanceId. */
const INSTANCE_ID_MESSAGES = new Set([
  'kill',
  'resume',
  'dismiss',
  'terminal:subscribe',
  'terminal:unsubscribe',
  'terminal:input',
  'terminal:resize',
]);

// Deliberately looser than isValidInstanceId: discovered instances can carry
// user-chosen ids (MOB_INSTANCE_ID with dots, etc.) that must still be
// dismissable/subscribable. This gate only needs to reject garbage payloads.
function payloadInstanceId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const id = (payload as { instanceId?: unknown }).instanceId;
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return null;
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f/\\]/.test(id) ? null : id;
}

export interface WsServerHandle {
  wss: WebSocketServer;
  setUpdateInfo(info: { current: string; latest: string } | null): void;
  onUpdateRestart(callback: () => void): void;
}

export function createWsServer(
  server: Server,
  instanceManager: InstanceManager,
  ptyManager: IPtyManager,
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
    // Clean up backpressure state
    outputBuffers.delete(id);
    const timer = batchTimers.get(id);
    if (timer) { clearTimeout(timer); batchTimers.delete(id); }
  });

  // Backpressure management: batch terminal data per-instance at ~60fps
  const BATCH_INTERVAL_MS = 16;
  // Threshold above which we defer a flush to wait for the client's WS buffer
  // to drain. Lower than the WS library's hard limit so we have headroom.
  const WS_BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024; // 4MB
  // Hard cap on the server-side accumulator. If we exceed this (client truly
  // stuck), we send anyway rather than holding indefinitely. Prefer corruption
  // over OOM at this point.
  const MAX_ACCUMULATED_BYTES = 32 * 1024 * 1024; // 32MB
  const outputBuffers = new Map<string, string>();
  const batchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** True if any subscriber is currently backpressured. */
  function anySubscriberBackpressured(subs: Set<WebSocket>): boolean {
    for (const client of subs) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) {
        return true;
      }
    }
    return false;
  }

  function scheduleFlush(instanceId: string): void {
    if (batchTimers.has(instanceId)) return;
    batchTimers.set(instanceId, setTimeout(() => {
      batchTimers.delete(instanceId);
      flushOutputBuffer(instanceId);
    }, BATCH_INTERVAL_MS));
  }

  function flushOutputBuffer(instanceId: string): void {
    const buffered = outputBuffers.get(instanceId);
    if (!buffered) return;

    const subs = instanceManager.subscribers.get(instanceId);
    if (!subs || subs.size === 0) {
      // No subscribers — drop the buffer (no one to send to)
      outputBuffers.delete(instanceId);
      return;
    }

    // If a subscriber is backpressured, defer the flush rather than dropping
    // bytes. ANSI sequences are stateful; dropping any portion produces
    // corrupted output. Only force-send if we've accumulated too much.
    if (
      buffered.length < MAX_ACCUMULATED_BYTES &&
      anySubscriberBackpressured(subs)
    ) {
      scheduleFlush(instanceId);
      return;
    }

    outputBuffers.delete(instanceId);

    const msg = JSON.stringify({
      type: 'terminal:output',
      payload: { instanceId, data: buffered },
    } satisfies ServerMessage);

    for (const client of subs) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  // Forward PTY data to subscribed clients (batched)
  ptyManager.on('data', (instanceId: string, data: string) => {
    const existing = outputBuffers.get(instanceId) || '';
    outputBuffers.set(instanceId, existing + data);
    scheduleFlush(instanceId);
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
      payload: { instances: snapshot, version: getVersion(), ...(updateInfo ? { updateAvailable: updateInfo } : {}) },
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

      if (msg.type !== 'terminal:input') {
        log.info( `Client #${clientId} → ${msg.type}`, 'payload' in msg ? (msg as any).payload : '');
      }

      // Reject malformed payloads up front so handlers can trust the shape.
      if (INSTANCE_ID_MESSAGES.has(msg.type) && !payloadInstanceId((msg as any).payload)) {
        log.warn( `Client #${clientId}: ${msg.type} with missing/invalid instanceId`);
        ws.send(JSON.stringify({
          type: 'error',
          payload: { message: `Invalid payload for ${msg.type}` },
        }));
        return;
      }

      try {
        switch (msg.type) {
          case 'sync':
            ws.send(JSON.stringify({
              type: 'snapshot',
              payload: { instances: instanceManager.getAll(), version: getVersion(), ...(updateInfo ? { updateAvailable: updateInfo } : {}) },
            } satisfies ServerMessage));
            break;

          case 'launch:check': {
            const checkValidation = validateLaunchPayload(msg.payload);
            if (!checkValidation.valid) {
              ws.send(JSON.stringify({
                type: 'error',
                payload: { message: checkValidation.error },
              }));
              break;
            }
            const conflicts = instanceManager.checkConflicts(checkValidation.data.cwd);
            ws.send(JSON.stringify({
              type: 'launch:conflicts',
              payload: conflicts,
            } satisfies ServerMessage));
            break;
          }

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

          case 'update:check': {
            log.info(`Client #${clientId} requested update check`);
            clearUpdateCache();
            checkForUpdate()
              .then((result) => {
                updateInfo = result;
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'update:available', payload: result } satisfies ServerMessage));
                }
              })
              .catch((err) => {
                log.error(`Update check failed: ${err instanceof Error ? err.message : err}`);
              });
            break;
          }

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

          case 'instance:edit': {
            const editValidation = validateEditPayload(msg.payload);
            if (!editValidation.valid) {
              ws.send(JSON.stringify({ type: 'error', payload: { message: editValidation.error } }));
              break;
            }
            const { instanceId: editId, ...editFields } = editValidation.data;
            log.info(`Client #${clientId} editing instance ${editId}:`, editFields);
            const edited = instanceManager.editInstance(editId, editFields);
            if (!edited) {
              ws.send(JSON.stringify({ type: 'error', payload: { message: 'Cannot edit instance', context: editId } }));
            }
            break;
          }

          default:
            log.warn( `Client #${clientId}: unknown message type: ${(msg as any).type}`);
            ws.send(JSON.stringify({
              type: 'error',
              payload: { message: `Unknown message type: ${(msg as any).type}` },
            }));
        }
      } catch (err) {
        // A handler threw. Report to the client instead of letting the throw
        // reach uncaughtException, which would shut down the whole server.
        const message = err instanceof Error ? err.message : String(err);
        log.error( `Client #${clientId}: error handling ${msg.type}: ${message}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { message: `Failed to handle ${msg.type}: ${message}` },
          }));
        }
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
