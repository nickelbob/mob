import type { Settings } from '../../shared/settings.js';

export async function loadSettings(): Promise<Settings> {
  const res = await fetch('/api/settings');
  return res.json();
}

export async function saveSettings(partial: Record<string, any>): Promise<Settings> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to save');
  }
  return res.json();
}
