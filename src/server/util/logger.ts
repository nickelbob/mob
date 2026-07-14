import fs from 'fs';
import path from 'path';
import os from 'os';

const logFile = path.join(os.homedir(), '.mob', 'server.log');

// Lazy append stream — appendFileSync on every log line serializes disk I/O
// onto the event loop (open/write/close per call on the hot path).
let logStream: fs.WriteStream | null = null;

function appendToFile(line: string) {
  try {
    if (!logStream) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      logStream = fs.createWriteStream(logFile, { flags: 'a' });
      logStream.on('error', () => { logStream = null; });
    }
    logStream.write(line + '\n');
  } catch {}
}

// warn/error stay synchronous: they're rare (not a hot-path cost) and are
// exactly the lines that must be on disk if the process dies right after —
// a buffered stream would lose the crash diagnostics the log exists for.
function appendToFileSync(line: string) {
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {}
}

export function createLogger(module: string) {
  function format(...args: unknown[]) {
    const ts = new Date().toISOString().slice(11, 23);
    return [`[${ts}] [${module}]`, ...args] as const;
  }

  function formatString(...args: unknown[]): string {
    const ts = new Date().toISOString().slice(11, 23);
    return `[${ts}] [${module}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  }

  return {
    info(...args: unknown[]) {
      console.log(...format(...args));
      appendToFile(formatString(...args));
    },
    warn(...args: unknown[]) {
      console.warn(...format(...args));
      appendToFileSync('WARN ' + formatString(...args));
    },
    error(...args: unknown[]) {
      console.error(...format(...args));
      appendToFileSync('ERROR ' + formatString(...args));
    },
  };
}
