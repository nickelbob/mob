import chokidar from 'chokidar';
import path from 'path';
import { EventEmitter } from 'events';
import { readStatusFile } from './status-reader.js';
import { createLogger } from './util/logger.js';
import { getInstancesDir } from './util/platform.js';
import { ensureDir } from './util/platform.js';
import { SESSION_MAX_AGE_MS } from '../shared/constants.js';

export class DiscoveryService extends EventEmitter {
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private dir: string;
  private log = createLogger('discovery');

  constructor() {
    super();
    this.dir = getInstancesDir();
  }

  /** Status files are {id}.json; dot-prefixed names are atomic-write temp files. */
  private isStatusFile(filePath: string): boolean {
    const base = path.basename(filePath);
    return base.endsWith('.json') && !base.startsWith('.');
  }

  start(): void {
    ensureDir(this.dir);
    // Watch the directory, not a glob — chokidar v4 removed glob support,
    // and a glob pattern is silently treated as a literal (non-existent)
    // path, so no events ever fire.
    this.watcher = chokidar.watch(this.dir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    this.watcher.on('add', (fp: string) => this.handleFileChange(fp));
    this.watcher.on('change', (fp: string) => this.handleFileChange(fp));
    this.watcher.on('unlink', (fp: string) => {
      if (!this.isStatusFile(fp)) return;
      const id = path.basename(fp, '.json');
      this.emit('remove', id);
    });

    // Without this listener an 'error' event becomes an uncaughtException and
    // takes the worker down. On Windows a status file being rewritten by the
    // hook (or held briefly by a scanner) makes chokidar's stat fail with
    // EPERM/EBUSY; the next write re-fires add/change, so dropping it is safe.
    this.watcher.on('error', (err: unknown) => {
      const e = err as NodeJS.ErrnoException;
      this.log.warn(`watcher error (ignored): ${e?.code ?? ''} ${e?.message ?? String(err)}`);
    });
  }

  private handleFileChange(filePath: string): void {
    if (!this.isStatusFile(filePath)) return;
    const status = readStatusFile(filePath);
    if (!status) return;
    // The instances dir is never pruned (files go back months) — don't seed
    // sessions older than the store's own retention window on startup.
    if (Date.now() - status.lastUpdated > SESSION_MAX_AGE_MS) return;
    this.emit('update', status, filePath);
  }

  stop(): void {
    this.watcher?.close();
  }
}
