import type { InstanceState } from '../../shared/protocol.js';

const previousStates = new Map<string, InstanceState>();

// Lazy-initialized audio element for notification sound
let notificationAudio: HTMLAudioElement | null = null;
function getNotificationAudio(): HTMLAudioElement {
  if (!notificationAudio) {
    notificationAudio = new Audio('/notification.wav');
    notificationAudio.volume = 0.5;
  }
  return notificationAudio;
}

export function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

export function checkWaitingNotification(
  instanceId: string,
  instanceName: string,
  newState: InstanceState,
  soundEnabled?: boolean,
): void {
  const prev = previousStates.get(instanceId);
  previousStates.set(instanceId, newState);

  if (newState !== 'waiting' || prev === 'waiting') return;

  // Play sound regardless of tab visibility (if enabled)
  if (soundEnabled) {
    const audio = getNotificationAudio();
    audio.currentTime = 0;
    audio.play().catch(() => {}); // Ignore autoplay restrictions
  }

  // Browser notification only when tab is hidden
  if (
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
