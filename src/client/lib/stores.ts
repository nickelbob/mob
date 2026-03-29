import { writable, derived, get } from 'svelte/store';
import type { InstanceInfo, LaunchConflicts } from './types.js';
import type { Settings } from '../../shared/settings.js';
import { DEFAULT_SETTINGS } from '../../shared/settings.js';
import { WsClient } from './ws-client.js';
import { loadSettings } from './settings-client.js';
import { requestNotificationPermission, checkWaitingNotification, clearInstanceState } from './notifications.js';

export const wsClient = new WsClient();
export const instances = writable<Map<string, InstanceInfo>>(new Map());
export const selectedInstanceId = writable<string | null>(null);
export const wsConnected = writable(false);
export const showLaunchDialog = writable(false);
export const showSettingsDialog = writable(false);
export const settings = writable<Settings>(structuredClone(DEFAULT_SETTINGS));
export const sidebarCollapsed = writable(false);
export const errors = writable<Array<{ message: string; context?: string; timestamp: number }>>([]);
export const updateAvailable = writable<{ current: string; latest: string } | null>(null);
export const updateStatus = writable<'idle' | 'installing' | 'success' | 'failed'>('idle');
export const updateError = writable<string | null>(null);
export const launchConflicts = writable<LaunchConflicts | null>(null);

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

export interface ProjectGroup {
  project: string;
  instances: InstanceInfo[];
}

export const groupedInstances = derived(sortedInstances, ($sorted) => {
  const groups = new Map<string, InstanceInfo[]>();
  for (const instance of $sorted) {
    // Use the last directory component as the project name
    const cwd = instance.cwd || '';
    const project = cwd.split('/').filter(Boolean).pop() || 'Unknown';
    const list = groups.get(project) || [];
    list.push(instance);
    groups.set(project, list);
  }
  // Sort groups: groups with active instances first, then alphabetically
  return Array.from(groups.entries())
    .sort(([aName, aInstances], [bName, bInstances]) => {
      const aHasActive = aInstances.some(i => i.state !== 'stopped') ? 0 : 1;
      const bHasActive = bInstances.some(i => i.state !== 'stopped') ? 0 : 1;
      if (aHasActive !== bHasActive) return aHasActive - bHasActive;
      return aName.localeCompare(bName);
    })
    .map(([project, instances]): ProjectGroup => ({ project, instances }));
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
      if (msg.payload.updateAvailable) {
        updateAvailable.set(msg.payload.updateAvailable);
      }
      break;
    case 'instance:update':
      instances.update((map) => {
        map.set(msg.payload.id, msg.payload);
        return new Map(map);
      });
      if (get(settings).general.notifications) {
        const s = get(settings);
        checkWaitingNotification(msg.payload.id, msg.payload.name, msg.payload.state, s.general.notificationSound);
      }
      break;
    case 'instance:remove':
      instances.update((map) => {
        map.delete(msg.payload.instanceId);
        return new Map(map);
      });
      selectedInstanceId.update((id) =>
        id === msg.payload.instanceId ? null : id
      );
      clearInstanceState(msg.payload.instanceId);
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
    case 'update:status':
      updateStatus.set(msg.payload.status);
      if (msg.payload.error) {
        updateError.set(msg.payload.error);
      }
      break;
    case 'launch:conflicts':
      launchConflicts.set(msg.payload);
      break;
  }

  // terminal:scrollback and terminal:output are handled by TerminalPanel via onMessage
});

// Connect on load
wsClient.connect();

// Load settings from server
loadSettings()
  .then((s) => {
    settings.set(s);
    sidebarCollapsed.set(s.general.sidebarCollapsed);
    if (s.general.notifications) {
      requestNotificationPermission();
    }
  })
  .catch(() => {
    // Use defaults on failure
  });
