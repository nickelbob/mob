/**
 * PTY Supervisor process.
 *
 * Long-lived process that owns the PTY children. The server worker connects
 * to it via a Unix socket / named pipe and forwards PTY operations through.
 * When the server worker restarts (file change in dev), this process stays
 * alive, so claude sessions persist across restarts.
 */
import net from 'net';
import fs from 'fs';
import { PtyManager } from './pty-manager.js';
import { getSupervisorSocketPath } from './util/supervisor-paths.js';
import { ensureDir, getMobDir } from './util/platform.js';
import { DEFAULT_PORT } from '../shared/constants.js';
import { createLogger } from './util/logger.js';
import type { WorkerRequest, SupervisorEvent } from './supervisor-protocol.js';

const log = createLogger('supervisor');

const port = parseInt(process.env.MOB_PORT || '', 10) || DEFAULT_PORT;
const socketPath = getSupervisorSocketPath(port);

ensureDir(getMobDir());

// Clean up stale socket file (Unix only). On Windows, named pipes auto-clean.
if (process.platform !== 'win32') {
  try { fs.unlinkSync(socketPath); } catch { /* ok */ }
}

const ptyManager = new PtyManager();
const clients = new Set<net.Socket>();

function broadcast(event: SupervisorEvent): void {
  const line = JSON.stringify(event) + '\n';
  for (const client of clients) {
    if (!client.destroyed && client.writable) {
      client.write(line);
    }
  }
}

ptyManager.on('data', (id: string, data: string) => {
  broadcast({ type: 'data', id, data });
});
ptyManager.on('exit', (id: string, exitCode: number) => {
  broadcast({ type: 'exit', id, exitCode });
});
ptyManager.on('error', (id: string, error: unknown) => {
  broadcast({ type: 'error', id, error: error instanceof Error ? error.message : String(error) });
});

function handleRequest(req: WorkerRequest, socket: net.Socket): void {
  switch (req.type) {
    case 'spawn':
      try {
        ptyManager.spawn(req.id, req.cwd, req.opts);
        log.info(`spawned ${req.id} in ${req.cwd}`);
      } catch (err: any) {
        log.error(`spawn failed for ${req.id}:`, err.message);
        const line = JSON.stringify({ type: 'error', id: req.id, error: err.message } satisfies SupervisorEvent) + '\n';
        socket.write(line);
      }
      break;
    case 'write':
      ptyManager.write(req.id, req.data);
      break;
    case 'resize':
      ptyManager.resize(req.id, req.cols, req.rows);
      break;
    case 'kill':
      log.info(`kill request for ${req.id}`);
      ptyManager.kill(req.id);
      break;
    case 'list': {
      const ids = Array.from(ptyManager.getAll().keys());
      const line = JSON.stringify({ type: 'list', ids } satisfies SupervisorEvent) + '\n';
      socket.write(line);
      break;
    }
  }
}

const server = net.createServer((socket) => {
  clients.add(socket);
  log.info(`worker connected (total ${clients.size})`);

  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: WorkerRequest;
      try { req = JSON.parse(line); } catch {
        log.warn(`malformed request: ${line.slice(0, 100)}`);
        continue;
      }
      handleRequest(req, socket);
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    log.info(`worker disconnected (remaining ${clients.size})`);
  });
  socket.on('error', (err: Error) => {
    log.warn(`socket error: ${err.message}`);
    clients.delete(socket);
  });
});

server.listen(socketPath, () => {
  log.info(`listening on ${socketPath}`);
});

function shutdown() {
  log.info('shutting down — killing all PTYs');
  const ids = Array.from(ptyManager.getAll().keys());
  for (const id of ids) {
    ptyManager.kill(id);
  }
  server.close();
  // Give tree-kill a moment to do its thing
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  log.error('uncaught exception:', err);
  shutdown();
});
