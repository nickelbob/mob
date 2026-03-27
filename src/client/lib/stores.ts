import { writable, derived } from 'svelte/store';
import type { InstanceInfo } from './types.js';
import { WsClient } from './ws-client.js';

export const wsClient = new WsClient();
export const instances = writable<Map<string, InstanceInfo>>(new Map());
export const selectedInstanceId = writable<string | null>(null);
export const wsConnected = writable(false);
export const showLaunchDialog = writable(false);
export const sidebarCollapsed = writable(false);
export const errors = writable<Array<{ message: string; context?: string; timestamp: number }>>([]);

export const selectedInstance = derived(
  [instances, selectedInstanceId],
  ([$instances, $id]) => ($id ? $instances.get($id) ?? null : null)
);

export const sortedInstances = derived(instances, ($instances) => {
  return Array.from($instances.values()).sort((a, b) => {
    // Stable sort: by creation time (oldest first), stopped instances last
    const aStop = a.state === 'stopped' ? 1 : 0;
    const bStop = b.state === 'stopped' ? 1 : 0;
    if (aStop !== bStop) return aStop - bStop;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
});

// Wire up WebSocket to stores
wsClient.setConnectionHandler((connected) => {
  wsConnected.set(connected);
});

// Event emitter for instance removal (used by TerminalPanel for cache cleanup)
type InstanceRemoveHandler = (instanceId: string) => void;
const instanceRemoveHandlers = new Set<InstanceRemoveHandler>();
export function onInstanceRemove(handler: InstanceRemoveHandler): () => void {
  instanceRemoveHandlers.add(handler);
  return () => instanceRemoveHandlers.delete(handler);
}

wsClient.onMessage((msg) => {
  switch (msg.type) {
    case 'snapshot':
      instances.set(new Map(msg.payload.instances.map((i) => [i.id, i])));
      break;
    case 'instance:update':
      instances.update((map) => {
        map.set(msg.payload.id, msg.payload);
        return new Map(map);
      });
      break;
    case 'instance:remove':
      instances.update((map) => {
        map.delete(msg.payload.instanceId);
        return new Map(map);
      });
      selectedInstanceId.update((id) =>
        id === msg.payload.instanceId ? null : id
      );
      // Notify listeners (e.g., TerminalPanel) for cache cleanup
      for (const handler of instanceRemoveHandlers) {
        handler(msg.payload.instanceId);
      }
      break;
    case 'instance:select':
      selectedInstanceId.set(msg.payload.instanceId);
      break;
    case 'error':
      errors.update((errs) => [
        ...errs.slice(-19), // keep last 20
        { message: msg.payload.message, context: msg.payload.context, timestamp: Date.now() },
      ]);
      break;
  }

  // terminal:scrollback and terminal:output are handled by TerminalPanel via onMessage
});

// Connect on load
wsClient.connect();
