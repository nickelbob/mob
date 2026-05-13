/**
 * Dev orchestrator.
 *
 * Spawns three processes:
 *   1. PTY supervisor    — owns the PTYs; never restarts. Survives worker reloads.
 *   2. Server worker     — Express + WebSocket. Restarts on src/server changes
 *                          via `tsx watch`. Connects to the supervisor over IPC.
 *   3. Vite              — client dev server with HMR.
 *
 * On Ctrl+C, terminates all three and kills the PTYs (supervisor's shutdown).
 */
import { spawn, type ChildProcess } from 'child_process';
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

// 1. Supervisor — no watch, no special env needed
startProcess('supervisor', 'tsx', ['src/server/pty-supervisor.ts']);

// 2. Worker — tsx watch restarts on file changes; MOB_SUPERVISOR tells it to use IPC.
// The worker retries connecting to the supervisor on startup, so no need to wait here.
startProcess('worker', 'tsx', ['watch', 'src/server/index.ts'], { MOB_SUPERVISOR: '1' });

// 3. Vite
startProcess('vite', 'vite', []);
