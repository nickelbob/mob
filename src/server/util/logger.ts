import fs from 'fs';
import path from 'path';
import os from 'os';

const logFile = path.join(os.homedir(), '.mob', 'server.log');

function appendToFile(line: string) {
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
      appendToFile('WARN ' + formatString(...args));
    },
    error(...args: unknown[]) {
      console.error(...format(...args));
      appendToFile('ERROR ' + formatString(...args));
    },
  };
}
