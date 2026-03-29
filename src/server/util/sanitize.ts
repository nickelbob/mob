import os from 'os';
import path from 'path';

// --- Shell quoting ---

/** Wrap a value in single quotes with proper escaping for safe shell interpolation. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// --- Field validators ---

const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]+$/;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const VALID_PERMISSION_MODES = ['default', 'plan', 'bypassPermissions', 'full'];

export function isValidModel(s: string): boolean {
  return MODEL_PATTERN.test(s) && s.length <= 100;
}

export function isValidPermissionMode(s: string): boolean {
  return VALID_PERMISSION_MODES.includes(s);
}

export function isValidSessionId(s: string): boolean {
  return SESSION_ID_PATTERN.test(s) && s.length <= 200;
}

export function isValidInstanceId(s: string): boolean {
  return INSTANCE_ID_PATTERN.test(s) && s.length <= 100;
}

export function isValidCwd(s: string): boolean {
  if (!s || s.length > 1024) return false;
  if (s.includes('\0')) return false;
  // Must be absolute path or start with ~
  return s.startsWith('/') || s.startsWith('~');
}

export function isValidName(s: string): boolean {
  return s.length <= 256;
}

/** Strip control characters (except newline/tab) from a string. */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// --- Path safety ---

/** Check if a resolved path is within the user's home directory. */
export function isPathWithinHome(resolved: string): boolean {
  const home = os.homedir();
  const normalized = path.resolve(resolved);
  return normalized === home || normalized.startsWith(home + path.sep);
}

// --- Payload validation ---

export interface ValidatedLaunchPayload {
  name: string;
  autoName?: boolean;
  cwd: string;
  model?: string;
  permissionMode?: string;
  cloneDir?: string;
  createDir?: boolean;
}

export function validateLaunchPayload(payload: unknown): { valid: true; data: ValidatedLaunchPayload } | { valid: false; error: string } {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be an object' };
  }

  const p = payload as Record<string, unknown>;

  // cwd: required, valid path
  if (typeof p.cwd !== 'string' || !isValidCwd(p.cwd)) {
    return { valid: false, error: 'Invalid or missing cwd (must be absolute path or start with ~, max 1024 chars)' };
  }

  // name: optional string, max 256 chars
  const name = typeof p.name === 'string' ? stripControlChars(p.name).slice(0, 256) : '';

  // model: optional, must match pattern
  if (p.model !== undefined && p.model !== '') {
    if (typeof p.model !== 'string' || !isValidModel(p.model)) {
      return { valid: false, error: 'Invalid model (alphanumeric, dots, colons, hyphens, slashes only)' };
    }
  }

  // permissionMode: optional, must be in allowlist
  if (p.permissionMode !== undefined && p.permissionMode !== '') {
    if (typeof p.permissionMode !== 'string' || !isValidPermissionMode(p.permissionMode)) {
      return { valid: false, error: `Invalid permissionMode (must be one of: ${VALID_PERMISSION_MODES.join(', ')})` };
    }
  }

  // cloneDir: optional, valid path
  if (p.cloneDir !== undefined && p.cloneDir !== '') {
    if (typeof p.cloneDir !== 'string' || !isValidCwd(p.cloneDir)) {
      return { valid: false, error: 'Invalid cloneDir (must be absolute path or start with ~, max 1024 chars)' };
    }
  }

  return {
    valid: true,
    data: {
      name,
      autoName: !!p.autoName,
      cwd: p.cwd,
      model: (typeof p.model === 'string' && p.model) || undefined,
      permissionMode: (typeof p.permissionMode === 'string' && p.permissionMode) || undefined,
      cloneDir: (typeof p.cloneDir === 'string' && p.cloneDir) || undefined,
      createDir: p.createDir === true ? true : undefined,
    },
  };
}

export function validateHookPayload(data: unknown): { valid: true; data: Record<string, unknown> } | { valid: false; error: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Payload must be an object' };
  }

  const d = data as Record<string, unknown>;

  // id: required
  if (typeof d.id !== 'string' || !d.id) {
    return { valid: false, error: 'Missing instance id' };
  }
  if (d.id.length > 200) {
    return { valid: false, error: 'Instance id too long' };
  }

  // cwd: optional but if present must be valid
  if (d.cwd !== undefined && typeof d.cwd === 'string') {
    if (d.cwd.includes('\0') || d.cwd.length > 1024) {
      return { valid: false, error: 'Invalid cwd' };
    }
  }

  // sessionId: optional, alphanumeric
  if (d.sessionId !== undefined && typeof d.sessionId === 'string') {
    if (!isValidSessionId(d.sessionId)) {
      return { valid: false, error: 'Invalid sessionId format' };
    }
  }

  // model: optional
  if (d.model !== undefined && typeof d.model === 'string' && d.model !== '') {
    if (!isValidModel(d.model)) {
      return { valid: false, error: 'Invalid model format' };
    }
  }

  // Strip control chars from string fields
  if (typeof d.name === 'string') d.name = stripControlChars(d.name).slice(0, 256);
  if (typeof d.subtask === 'string') d.subtask = stripControlChars(d.subtask).slice(0, 500);
  if (typeof d.topic === 'string') d.topic = stripControlChars(d.topic).slice(0, 500);
  if (typeof d.ticket === 'string') d.ticket = stripControlChars(d.ticket).slice(0, 200);
  if (typeof d.ticketStatus === 'string') d.ticketStatus = stripControlChars(d.ticketStatus).slice(0, 100);
  if (typeof d.hookEvent === 'string') d.hookEvent = stripControlChars(d.hookEvent).slice(0, 50);

  return { valid: true, data: d };
}
