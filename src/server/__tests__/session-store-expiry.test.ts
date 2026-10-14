import { describe, it, expect } from 'vitest';
import { isExpired, lastActiveOf } from '../session-store.js';
import { SESSION_MAX_AGE_MS } from '../../shared/constants.js';

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const old = NOW - (SESSION_MAX_AGE_MS + DAY); // comfortably past the cutoff
const recent = NOW - 1000;

describe('lastActiveOf', () => {
  it('prefers stoppedAt, then lastActivityAt, then createdAt', () => {
    expect(lastActiveOf({ createdAt: 1, lastActivityAt: 2, stoppedAt: 3 })).toBe(3);
    expect(lastActiveOf({ createdAt: 1, lastActivityAt: 2 })).toBe(2);
    expect(lastActiveOf({ createdAt: 1 })).toBe(1);
  });
});

describe('isExpired', () => {
  it('keeps a long-running session that is still active (the regression)', () => {
    // created 8 days ago, never stopped, but active seconds ago
    expect(isExpired({ id: 'a', createdAt: old, lastActivityAt: recent }, NOW)).toBe(false);
  });

  it('expires a session whose last activity is past the cutoff', () => {
    expect(isExpired({ id: 'a', createdAt: old, lastActivityAt: old }, NOW)).toBe(true);
  });

  it('never expires a session whose PTY is still alive, regardless of age', () => {
    const ancient = { id: 'a', createdAt: NOW - 90 * DAY, lastActivityAt: NOW - 90 * DAY };
    expect(isExpired(ancient, NOW, () => true)).toBe(false);
    expect(isExpired(ancient, NOW, () => false)).toBe(true);
  });

  it('uses stoppedAt when present', () => {
    expect(isExpired({ id: 'a', createdAt: old, stoppedAt: recent }, NOW)).toBe(false);
    expect(isExpired({ id: 'a', createdAt: recent, stoppedAt: old }, NOW)).toBe(true);
  });

  it('falls back to createdAt for legacy files without lastActivityAt', () => {
    expect(isExpired({ id: 'a', createdAt: recent }, NOW)).toBe(false);
    expect(isExpired({ id: 'a', createdAt: old }, NOW)).toBe(true);
  });
});
