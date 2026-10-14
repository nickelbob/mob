/**
 * Dev orchestrator.
 *
 * Spawns three processes:
 *   1. PTY supervisor    — owns the PTYs; never restarts. Survives worker reloads.
 *   2. Server worker     — Express + WebSocket. Restarts on src/server changes
 *                          via `tsx watch`. Connects to the supervisor over IPC.
 *   3. Vite              — client dev server with HMR.
 *
 * A watchdog polls the worker's port. `tsx watch` keeps running when its child
 * exits on its own (it only respawns on file changes), so without this a worker
 * crash left Vite serving a dashboard backed by a dead server. On repeated
 * failures the worker is respawned; it reconnects to the supervisor and adopts
 * the existing PTYs.
 *
 * On Ctrl+C, terminates all three and kills the PTYs (supervisor's shutdown).
 */
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import treeKill from 'tree-kill';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const procs: ChildProcess[] = [];

function startProcess(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const proc = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${name} exited with code ${code}`);
    }
    if (signal) {
      console.error(`[dev] ${name} terminated by ${signal}`);
    }
    const idx = procs.indexOf(proc);
    if (idx !== -1) procs.splice(idx, 1);
    // A worker we are deliberately replacing must not take the run down with it.
    if (restartingWorker) return;
    // If any process exits unexpectedly, shut everything down
    if (!shuttingDown) shutdown();
  });
  procs.push(proc);
  return proc;
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dev] Shutting down...');
  for (const p of procs) {
    if (!p.killed) p.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const WORKER_PORT = parseInt(process.env.MOB_PORT || '', 10) || 4040;
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_GRACE_MS = 30_000;
const FAILURES_BEFORE_RESTART = 3;
const MAX_WORKER_RESTARTS = 10;

let workerProc: ChildProcess;
let restartingWorker = false;
let consecutiveFailures = 0;
let workerRestarts = 0;

function startWorker(): ChildProcess {
  // tsx watch reloads on src/server changes; MOB_SUPERVISOR tells it to use IPC.
  // The worker retries connecting to the supervisor, so no need to wait here.
  return startProcess('worker', 'tsx', ['watch', 'src/server/index.ts'], { MOB_SUPERVISOR: '1' });
}

function probe(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: WORKER_PORT });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(3000);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function killWorkerTree(): Promise<void> {
  return new Promise((resolve) => {
    const pid = workerProc?.pid;
    if (!pid || workerProc.killed) return resolve();
    // `shell: true` on win32 means workerProc is a shell wrapping `tsx watch`,
    // which itself wraps the node worker. Killing only the wrapper would leave
    // the node child alive still holding the port, so kill the whole tree.
    treeKill(pid, 'SIGTERM', (err) => {
      if (err) treeKill(pid, 'SIGKILL', () => resolve());
      else resolve();
    });
    setTimeout(resolve, 5000);
  });
}

async function waitForPortFree(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probe())) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`[dev] port ${WORKER_PORT} still held after kill — starting worker anyway`);
}

async function restartWorker() {
  if (shuttingDown || restartingWorker) return;
  if (workerRestarts >= MAX_WORKER_RESTARTS) {
    console.error(`[dev] worker unhealthy and restart limit (${MAX_WORKER_RESTARTS}) reached — not restarting again`);
    return;
  }
  restartingWorker = true;
  workerRestarts++;
  console.error(`[dev] worker not responding on :${WORKER_PORT} — restarting (${workerRestarts}/${MAX_WORKER_RESTARTS})`);
  try {
    await killWorkerTree();
    await waitForPortFree(10_000);
    workerProc = startWorker();
  } finally {
    consecutiveFailures = 0;
    restartingWorker = false;
  }
}

function startHealthWatchdog() {
  setInterval(async () => {
    if (shuttingDown || restartingWorker) return;
    if (await probe()) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    console.error(`[dev] worker health check failed (${consecutiveFailures}/${FAILURES_BEFORE_RESTART})`);
    if (consecutiveFailures >= FAILURES_BEFORE_RESTART) await restartWorker();
  }, HEALTH_INTERVAL_MS).unref();
}

// 1. Supervisor — no watch, no special env needed
startProcess('supervisor', 'tsx', ['src/server/pty-supervisor.ts']);

// 2. Worker
workerProc = startWorker();

// 3. Vite
startProcess('vite', 'vite', []);

// Give the worker time to bind before the watchdog starts judging it.
setTimeout(startHealthWatchdog, HEALTH_GRACE_MS);
