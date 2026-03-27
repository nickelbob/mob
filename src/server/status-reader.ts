import fs from 'fs';
import type { InstanceStatusFile } from './types.js';

export function readStatusFile(filePath: string): InstanceStatusFile | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.id || !data.cwd || !data.lastUpdated) {
      return null;
    }
    return {
      id: data.id,
      cwd: data.cwd,
      gitBranch: data.gitBranch || undefined,
      state: data.state || 'running',
      ticket: data.ticket || undefined,
      ticketStatus: data.ticketStatus || undefined,
      subtask: data.subtask || undefined,
      progress: typeof data.progress === 'number' ? data.progress : undefined,
      currentTool: data.currentTool || undefined,
      lastUpdated: data.lastUpdated,
      sessionId: data.sessionId || undefined,
      model: data.model || undefined,
      topic: data.topic || undefined,
    };
  } catch {
    return null;
  }
}
