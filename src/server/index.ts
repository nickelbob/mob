import http from 'http';
import { createApp } from './express-app.js';
import { createWsServer } from './ws-server.js';
import { InstanceManager } from './instance-manager.js';
import { PtyManager } from './pty-manager.js';
import { DiscoveryService } from './discovery.js';
import { SessionStore } from './session-store.js';
import { ScrollbackBuffer } from './scrollback-buffer.js';
import { SettingsManager } from './settings-manager.js';
import { ensureDir, getMobDir, getInstancesDir, getSessionsDir, getScrollbackDir } from './util/platform.js';
import { DEFAULT_PORT } from '../shared/constants.js';

const port = parseInt(process.env.MOB_PORT || '', 10) || DEFAULT_PORT;
const host = process.env.MOB_HOST || '127.0.0.1';

// Ensure directories exist
ensureDir(getMobDir());
ensureDir(getInstancesDir());
ensureDir(getSessionsDir());
ensureDir(getScrollbackDir());

const settingsManager = new SettingsManager();
const ptyManager = new PtyManager();
const discovery = new DiscoveryService();
const sessionStore = new SessionStore();
const scrollbackBuffer = new ScrollbackBuffer();
scrollbackBuffer.start();

sessionStore.pruneExpired();

const instanceManager = new InstanceManager(ptyManager, discovery, sessionStore, scrollbackBuffer, settingsManager);

const app = createApp(instanceManager, settingsManager);
const server = http.createServer(app);
createWsServer(server, instanceManager, ptyManager);

discovery.start();
instanceManager.startStaleCheck();

server.listen(port, host, () => {
  console.log(`Mob dashboard running at http://${host}:${port}`);
  console.log(`WebSocket endpoint: ws://${host}:${port}/mob-ws`);
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  instanceManager.saveAllAsStopped();

  // Kill all PTY processes
  for (const [id] of ptyManager.getAll()) {
    console.log(`Killing PTY: ${id}`);
    ptyManager.kill(id);
  }

  scrollbackBuffer.stop();
  instanceManager.stop();

  // Brief grace period for clean exit
  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
