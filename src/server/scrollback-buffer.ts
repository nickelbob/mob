import fs from 'fs';
import path from 'path';
import { getScrollbackDir } from './util/platform.js';
import { SCROLLBACK_MAX_BYTES, SCROLLBACK_FLUSH_MS } from '../shared/constants.js';

function log(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [scrollback]`, ...args);
}

interface BufferEntry {
  chunks: string[];
  byteLength: number;
  dirty: boolean;
}

export class ScrollbackBuffer {
  private buffers = new Map<string, BufferEntry>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.flushTimer = setInterval(() => this.flushDirty(), SCROLLBACK_FLUSH_MS);
  }

  append(instanceId: string, data: string): void {
    let entry = this.buffers.get(instanceId);
    if (!entry) {
      entry = { chunks: [], byteLength: 0, dirty: false };
      this.buffers.set(instanceId, entry);
    }

    const bytes = Buffer.byteLength(data, 'utf8');
    entry.chunks.push(data);
    entry.byteLength += bytes;
    entry.dirty = true;

    // Trim oldest chunks if over max
    while (entry.byteLength > SCROLLBACK_MAX_BYTES && entry.chunks.length > 1) {
      const removed = entry.chunks.shift()!;
      entry.byteLength -= Buffer.byteLength(removed, 'utf8');
    }
  }

  getTail(instanceId: string, chars: number): string {
    const entry = this.buffers.get(instanceId);
    if (!entry || entry.chunks.length === 0) return '';
    // Walk chunks from the end, collecting up to `chars` characters
    let result = '';
    for (let i = entry.chunks.length - 1; i >= 0 && result.length < chars; i--) {
      result = entry.chunks[i] + result;
    }
    return result.length > chars ? result.slice(-chars) : result;
  }

  getBuffer(instanceId: string): string {
    const entry = this.buffers.get(instanceId);
    if (entry) return entry.chunks.join('');

    // Try reading from disk
    const filePath = path.join(getScrollbackDir(), `${instanceId}.log`);
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private flushDirty(): void {
    const dir = getScrollbackDir();
    for (const [instanceId, entry] of this.buffers) {
      if (!entry.dirty) continue;
      try {
        const filePath = path.join(dir, `${instanceId}.log`);
        fs.writeFileSync(filePath, entry.chunks.join(''), 'utf8');
        entry.dirty = false;
      } catch (err) {
        log(`Failed to flush ${instanceId}:`, err);
      }
    }
  }

  flushAll(): void {
    const dir = getScrollbackDir();
    for (const [instanceId, entry] of this.buffers) {
      if (!entry.dirty) continue;
      try {
        const filePath = path.join(dir, `${instanceId}.log`);
        fs.writeFileSync(filePath, entry.chunks.join(''), 'utf8');
        entry.dirty = false;
      } catch (err) {
        log(`Failed to flush ${instanceId}:`, err);
      }
    }
  }

  remove(instanceId: string): void {
    this.buffers.delete(instanceId);
    const filePath = path.join(getScrollbackDir(), `${instanceId}.log`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File may not exist
    }
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAll();
  }
}
