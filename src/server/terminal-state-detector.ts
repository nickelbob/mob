import type { InstanceState } from '../shared/protocol.js';

// Strip ANSI escape sequences so pattern matching works on clean text
// Covers: CSI sequences (including DEC private mode like ?2026h), OSC, and charset selection
const ANSI_RE = /\x1B(?:\[[\x20-\x3F]*[\x40-\x7E]|\][^\x07]*\x07|\([A-B0-2])/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// --- WAITING patterns ---
// Only checked against the last few lines of output to avoid false positives
// from words in Claude's response body. Real permission prompts always appear
// at the very end of output.
const WAITING_PATTERNS = [
  /\(y\/n\)/i,                     // Permission prompts: "Allow X? (y/n)"
  /\[y\/n\]/i,
  /Do you want to proceed/i,
  /\?\s*\(yes\b.*\bno\b\)/i,      // "? (yes/no)" style prompts
];

// --- RUNNING patterns ---
// Checked against the full tail — spinner/status text can appear anywhere.
const RUNNING_PATTERNS = [
  /esc to interrupt/i,
  /thinking\b/i,
  /\bRuminating/,
];

// --- IDLE patterns ---
// Only checked against the prompt zone (end of output).
const IDLE_PATTERNS = [
  />\s*$/,        // Claude's `> ` prompt
  /\$\s*$/,       // Shell `$ ` prompt
];

// How many characters from the end to consider the "prompt zone".
// Real prompts appear on the last 1-2 lines, so keep this tight.
const PROMPT_ZONE_CHARS = 80;

export function detectStateFromTerminal(scrollbackTail: string): InstanceState | null {
  if (!scrollbackTail || scrollbackTail.length === 0) return null;

  const clean = stripAnsi(scrollbackTail);

  // The "prompt zone" is the last ~150 chars where actual prompts/questions appear
  const promptZone = clean.slice(-PROMPT_ZONE_CHARS);

  // Check waiting patterns against prompt zone only (not the whole buffer)
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(promptZone)) return 'waiting';
  }

  // Check running patterns against the full tail
  for (const pattern of RUNNING_PATTERNS) {
    if (pattern.test(clean)) return 'running';
  }

  // Check idle patterns against prompt zone
  for (const pattern of IDLE_PATTERNS) {
    if (pattern.test(promptZone)) return 'idle';
  }

  return null;
}
