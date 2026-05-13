import path from 'path';
import os from 'os';
import { getMobDir } from './platform.js';

/**
 * Returns the IPC endpoint path for the PTY supervisor.
 * - Linux/Mac: a Unix socket under ~/.mob/
 * - Windows: a named pipe at \\.\pipe\mob-pty-supervisor-<port>
 *
 * The endpoint is keyed by port so multiple dashboard instances don't collide.
 */
export function getSupervisorSocketPath(port: number): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mob-pty-supervisor-${port}`;
  }
  return path.join(getMobDir(), `pty-supervisor-${port}.sock`);
}
