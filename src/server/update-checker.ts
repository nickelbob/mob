import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createLogger } from './util/logger.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

const log = createLogger('update');

const __dirname = dirname(fileURLToPath(import.meta.url));

function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return join(__dirname, '..', '..');
}

const packageRoot = findPackageRoot();

function getCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));
  return pkg.version;
}

export function getVersion(): string {
  return getCurrentVersion();
}

function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

let cached: { current: string; latest: string } | null | undefined;

export function clearUpdateCache(): void {
  cached = undefined;
}

export async function checkForUpdate(): Promise<{ current: string; latest: string } | null> {
  if (cached !== undefined) return cached;
  try {
    const current = getCurrentVersion();
    const res = await fetch('https://registry.npmjs.org/mob-coordinator', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      cached = null;
      return null;
    }
    const data = await res.json();
    const latest = data['dist-tags']?.latest;
    if (!latest || typeof latest !== 'string' || !SEMVER_RE.test(latest) || !isNewer(latest, current)) {
      cached = null;
      return null;
    }
    cached = { current, latest };
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function performUpdate(latest: string): { success: boolean; error?: string } {
  if (!SEMVER_RE.test(latest)) {
    return { success: false, error: 'Invalid version format' };
  }
  try {
    log.info(`Installing mob-coordinator@${latest}...`);
    execFileSync('npm', ['install', '-g', `mob-coordinator@${latest}`], {
      timeout: 30_000,
      stdio: 'pipe',
    });
    log.info('Update installed successfully');
    return { success: true };
  } catch (err: any) {
    const raw = err.stderr?.toString() || err.message || 'Unknown error';
    log.error('Update failed:', raw);
    // Sanitize before returning to clients — strip paths and tokens
    const sanitized = raw
      .replace(/\/(?:home|Users|root|usr|tmp)\/[^\s]*/g, '<path>')
      .replace(/\/\/registry\.[^\s]*/g, '<registry>')
      .slice(0, 200);
    return { success: false, error: sanitized };
  }
}
