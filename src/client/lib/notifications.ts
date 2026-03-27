import type { InstanceState } from '../../shared/protocol.js';

const previousStates = new Map<string, InstanceState>();

export function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

export function checkWaitingNotification(instanceId: string, instanceName: string, newState: InstanceState): void {
  const prev = previousStates.get(instanceId);
  previousStates.set(instanceId, newState);

  if (
    newState === 'waiting' &&
    prev !== 'waiting' &&
    document.hidden &&
    'Notification' in window &&
    Notification.permission === 'granted'
  ) {
    new Notification(`${instanceName} needs input`, {
      body: 'An instance is waiting for approval or input.',
      tag: `mob-waiting-${instanceId}`,
    });
  }
}

export function clearInstanceState(instanceId: string): void {
  previousStates.delete(instanceId);
}
