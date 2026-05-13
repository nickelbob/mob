/**
 * IPC protocol between the PTY supervisor process and the server worker.
 * Newline-delimited JSON over a Unix socket (Linux/Mac) or named pipe (Windows).
 */

export interface SupervisorSpawnOpts {
  model?: string;
  permissionMode?: string;
  claudeSessionId?: string;
  resume?: boolean;
  setupCommands?: string[];
}

/** Worker → Supervisor. */
export type WorkerRequest =
  | { type: 'spawn'; id: string; cwd: string; opts?: SupervisorSpawnOpts }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string }
  | { type: 'list' };

/** Supervisor → Worker. */
export type SupervisorEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  | { type: 'error'; id: string; error: string }
  | { type: 'list'; ids: string[] };
