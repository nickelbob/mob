// Client → Server messages
export type ClientMessage =
  | { type: 'sync' }
  | { type: 'launch'; payload: LaunchPayload }
  | { type: 'launch:check'; payload: LaunchPayload }
  | { type: 'kill'; payload: { instanceId: string } }
  | { type: 'resume'; payload: { instanceId: string } }
  | { type: 'dismiss'; payload: { instanceId: string } }
  | { type: 'terminal:subscribe'; payload: { instanceId: string } }
  | { type: 'terminal:unsubscribe'; payload: { instanceId: string } }
  | { type: 'terminal:input'; payload: { instanceId: string; data: string } }
  | { type: 'terminal:resize'; payload: { instanceId: string; cols: number; rows: number } }
  | { type: 'update:install' }
  | { type: 'update:check' }
  | { type: 'instance:edit'; payload: InstanceEditPayload };

export interface LaunchPayload {
  name: string;
  autoName?: boolean;
  cwd: string;
  model?: string;
  permissionMode?: string;
  cloneDir?: string;
  createDir?: boolean;
  project?: string;
}

export interface InstanceEditPayload {
  instanceId: string;
  name?: string;
  project?: string;
  model?: string;
  permissionMode?: string;
}

// Server → Client messages
export type ServerMessage =
  | { type: 'snapshot'; payload: { instances: InstanceInfo[]; version: string; updateAvailable?: { current: string; latest: string } } }
  | { type: 'instance:update'; payload: InstanceInfo }
  | { type: 'instance:remove'; payload: { instanceId: string } }
  | { type: 'terminal:output'; payload: { instanceId: string; data: string } }
  | { type: 'terminal:scrollback'; payload: { instanceId: string; data: string } }
  | { type: 'terminal:exit'; payload: { instanceId: string; exitCode: number } }
  | { type: 'error'; payload: { message: string; context?: string } }
  | { type: 'instance:select'; payload: { instanceId: string } }
  | { type: 'update:status'; payload: { status: 'installing' | 'success' | 'failed'; error?: string } }
  | { type: 'update:available'; payload: { current: string; latest: string } | null }
  | { type: 'launch:conflicts'; payload: LaunchConflicts };

export interface LaunchConflicts {
  cwd: string;
  cwdExists: boolean;
  sameDirInstances: Array<{ id: string; name: string; state: InstanceState }>;
  sameBranchInstances: Array<{ id: string; name: string; branch: string; cwd: string }>;
}

export interface InstanceInfo {
  id: string;
  name: string;
  managed: boolean;
  cwd: string;
  project?: string;
  gitRoot?: string;
  gitRemoteUrl?: string;
  gitBranch?: string;
  state: InstanceState;
  ticket?: string;
  ticketUrl?: string;
  ticketStatus?: string;
  subtask?: string;
  progress?: number;
  currentTool?: string;
  lastUpdated: number;
  model?: string;
  permissionMode?: string;
  createdAt?: number;
  stoppedAt?: number;
  claudeSessionId?: string;
  previousInstanceId?: string;
  historical?: boolean;
  lastHookUpdate?: number;
  lastHookEvent?: string;
}

export type InstanceState = 'launching' | 'running' | 'idle' | 'waiting' | 'stopped';
