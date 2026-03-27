import chokidar from 'chokidar';
import path from 'path';
import { EventEmitter } from 'events';
import { readStatusFile } from './status-reader.js';
import { getInstancesDir } from './util/platform.js';
import { ensureDir } from './util/platform.js';
import type { InstanceStatusFile } from './types.js';

export class DiscoveryService extends EventEmitter {
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private dir: string;

  constructor() {
    super();
    this.dir = getInstancesDir();
  }

  start(): void {
    ensureDir(this.dir);
    this.watcher = chokidar.watch(path.join(this.dir, '*.json'), {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    this.watcher.on('add', (fp: string) => this.handleFileChange(fp));
    this.watcher.on('change', (fp: string) => this.handleFileChange(fp));
    this.watcher.on('unlink', (fp: string) => {
      const id = path.basename(fp, '.json');
      this.emit('remove', id);
    });
  }

  private handleFileChange(filePath: string): void {
    const status = readStatusFile(filePath);
    if (status) {
      this.emit('update', status, filePath);
    }
  }

  stop(): void {
    this.watcher?.close();
  }
}
