import type { InstanceInfo, InstanceState } from '../shared/protocol.js';
import type { IPty } from '@lydell/node-pty';

export interface ManagedInstance {
  info: InstanceInfo;
  pty: IPty;
  subscribers: Set<import('ws').WebSocket>;
}

export interface DiscoveredInstance {
  info: InstanceInfo;
  filePath: string;
}

export interface InstanceStatusFile {
  id: string;
  cwd: string;
  gitBranch?: string;
  state: InstanceState;
  ticket?: string;
  ticketStatus?: string;
  subtask?: string;
  topic?: string;
  progress?: number;
  currentTool?: string;
  lastUpdated: number;
  sessionId?: string;
  model?: string;
}

export interface HookPayload {
  instanceId: string;
  cwd: string;
  gitBranch?: string;
  state: InstanceState;
  ticket?: string;
  subtask?: string;
  progress?: number;
  currentTool?: string;
  sessionId?: string;
}
