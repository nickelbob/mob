import type { InstanceState } from '../shared/protocol.js';

// Braille spinner characters used by Claude CLI
const SPINNER_CHARS = '⠋⠙⠚⠞⠖⠦⠴⠵⠸⠇⠏';

// Patterns checked in priority order: waiting > running > idle
const WAITING_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\bapprove\b/i,
  /\ballow\b/i,
  /Do you want to proceed/i,
  /\byes\b.*\bno\b/i,
  /\baccept\b/i,
  /\bdeny\b/i,
];

const RUNNING_PATTERNS = [
  /esc to interrupt/i,
  new RegExp(`[${SPINNER_CHARS}]`),
];

// Idle: bare prompt at end of output
const IDLE_PATTERNS = [
  />\s*$/,        // Claude's `> ` prompt
  /\$\s*$/,       // Shell `$ ` prompt
];

export function detectStateFromTerminal(scrollbackTail: string): InstanceState | null {
  if (!scrollbackTail || scrollbackTail.length === 0) return null;

  // Check waiting patterns first (highest priority)
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(scrollbackTail)) return 'waiting';
  }

  // Check running patterns
  for (const pattern of RUNNING_PATTERNS) {
    if (pattern.test(scrollbackTail)) return 'running';
  }

  // Check idle patterns (only match end of output)
  for (const pattern of IDLE_PATTERNS) {
    if (pattern.test(scrollbackTail)) return 'idle';
  }

  return null;
}
