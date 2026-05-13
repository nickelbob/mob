import http from 'http';
import { createApp } from './express-app.js';
import { createWsServer } from './ws-server.js';
import { InstanceManager } from './instance-manager.js';
import { PtyManager, type IPtyManager } from './pty-manager.js';
import { RemotePtyManager } from './remote-pty-manager.js';
import { DiscoveryService } from './discovery.js';
import { SessionStore } from './session-store.js';
import { ScrollbackBuffer } from './scrollback-buffer.js';
import { SettingsManager } from './settings-manager.js';
import { ensureDir, getMobDir, getInstancesDir, getSessionsDir, getScrollbackDir } from './util/platform.js';
import { DEFAULT_PORT } from '../shared/constants.js';
import { installHooks } from './hooks.js';
import { checkForUpdate } from './update-checker.js';

const RESTART_EXIT_CODE = 75;

const port = parseInt(process.env.MOB_PORT || '', 10) || DEFAULT_PORT;
const host = process.env.MOB_HOST || '127.0.0.1';
// When MOB_SUPERVISOR=1, run as a worker that delegates PTY ownership to a
// separate supervisor process. PTYs then survive this worker restarting on
// code changes. Default (unset) is single-process mode for production use.
const useSupervisor = process.env.MOB_SUPERVISOR === '1';

// Ensure directories exist
ensureDir(getMobDir());
ensureDir(getInstancesDir());
ensureDir(getSessionsDir());
ensureDir(getScrollbackDir());

// Auto-install Claude Code hooks so external instances are discovered
if (!process.env.MOB_NO_HOOKS) {
  const packageRoot = new URL('../../..', import.meta.url).pathname;
  installHooks(packageRoot, true);
}

async function buildPtyManager(): Promise<IPtyManager> {
  if (!useSupervisor) {
    return new PtyManager();
  }
  const remote = new RemotePtyManager(port);
  await remote.connect();
  const existing = await remote.listExisting();
  if (existing.length > 0) {
    console.log(`Adopted ${existing.length} existing PTY(s) from supervisor: ${existing.join(', ')}`);
  }
  return remote;
}

async function main() {
  const settingsManager = new SettingsManager();
  const ptyManager = await buildPtyManager();
  const discovery = new DiscoveryService();
  const sessionStore = new SessionStore();
  const scrollbackBuffer = new ScrollbackBuffer();
  scrollbackBuffer.start();

  sessionStore.pruneExpired();

  const instanceManager = new InstanceManager(ptyManager, discovery, sessionStore, scrollbackBuffer, settingsManager);

  const app = createApp(instanceManager, settingsManager);
  const server = http.createServer(app);
  const wsHandle = createWsServer(server, instanceManager, ptyManager);

  wsHandle.onUpdateRestart(() => {
    console.log('Update installed, restarting...');
    gracefulShutdown(() => process.exit(RESTART_EXIT_CODE));
  });

  discovery.start();
  instanceManager.startStaleCheck();

  server.listen(port, host, () => {
    console.log(`Mob dashboard running at http://${host}:${port}`);
    console.log(`WebSocket endpoint: ws://${host}:${port}/mob-ws`);
    if (useSupervisor) console.log('(PTYs are managed by an external supervisor; this worker can restart safely)');

    // Check for updates in background after server is ready
    checkForUpdate().then((update) => {
      if (update) {
        console.log(`\nUpdate available: ${update.current} → ${update.latest}`);
        console.log(`Run: npm i -g mob-coordinator\n`);
        wsHandle.setUpdateInfo(update);
      }
    });
  });

  // Graceful shutdown
  function gracefulShutdown(done: () => void) {
    console.log('\nShutting down...');
    instanceManager.saveAllAsStopped();

    // In supervisor mode, PTYs are owned by the supervisor — leave them alive
    // so they survive this worker restart. In single-process mode, kill them.
    if (!useSupervisor) {
      for (const [id] of ptyManager.getAll()) {
        console.log(`Killing PTY: ${id}`);
        ptyManager.kill(id);
      }
    }

    scrollbackBuffer.stop();
    instanceManager.stop();

    setTimeout(() => {
      server.close();
      done();
    }, 500);
  }

  process.on('SIGINT', () => gracefulShutdown(() => process.exit(0)));
  process.on('SIGTERM', () => gracefulShutdown(() => process.exit(0)));

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    gracefulShutdown(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
