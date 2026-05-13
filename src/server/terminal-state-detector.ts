import type { InstanceState } from '../shared/protocol.js';

// Strip ANSI escape sequences so pattern matching works on clean text.
// Covers CSI (including DEC private mode like ?2026h), OSC, and charset selection.
const ANSI_RE = /\x1B(?:\[[\x20-\x3F]*[\x40-\x7E]|\][^\x07]*\x07|\([A-B0-2])/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// Last N chars used for prompt-zone checks (waiting + explicit idle markers).
// Sized to fit Claude's TUI footer layout: the mode line plus padding plus
// status line ("You've used X% of your weekly limit ..." can wrap to ~80 chars
// on a wide terminal, with surrounding right-aligned padding ~150 chars).
const PROMPT_ZONE_CHARS = 600;

// Window over which running indicators (spinner / "thinking" / etc) are scanned.
// Sized close to one screenful: a live spinner reprints every frame and will
// be in this window when Claude is actually active, while old spinner text
// from a turn that ended seconds ago falls out quickly.
const RUN_SCAN_CHARS = 600;

// Permission / yes-no prompts. Always appear at the very end of output.
const WAITING_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /Do you want to proceed/i,
  /\?\s*\(yes\b.*\bno\b\)/i,
];

// Strong positive idle markers — Claude's TUI footer below its prompt box.
// "auto mode on (shift+tab to cycle)" / "plan mode on" / "accept edits mode on".
// These only render when the TUI is at its input prompt — not during processing.
const IDLE_PATTERNS = [
  /(?:auto|plan|accept edits)\s+mode\s+on/i,
  /\(shift\+tab to cycle\)/i,
  /^\s*>\s*$/m,
];

// Active-processing markers. "esc to interrupt" is the canonical signal —
// Claude Code's TUI appends it to the mode line on every frame the spinner
// is active (during thinking, tool calls, anything interruptible). When the
// spinner stops and Claude returns to its prompt, the suffix is no longer
// rendered, and the latest mode-line in the buffer reads as plain idle.
//
// We deliberately do NOT include bare verb words or spinner glyphs here:
// the buffer retains old running-state text (`Cooking…`, `✻ Cogitated for X`)
// after Claude has transitioned back to idle, which would cause persistent
// false-positive running classifications.
const RUNNING_PATTERNS = [
  /esc to interrupt/i,
];

/**
 * Best-effort state classification from raw PTY scrollback. Caller is
 * responsible for deciding when to consult this (the InstanceManager only
 * uses it when hooks haven't fired recently or when verifying a stale
 * 'running' state).
 *
 * Returns 'waiting' | 'idle' | 'running'. Never returns null — when nothing
 * matches, 'idle' is the safe default (Claude with no observable activity).
 */
export function detectStateFromTerminal(scrollbackTail: string): InstanceState {
  if (!scrollbackTail || scrollbackTail.length === 0) return 'idle';

  const clean = stripAnsi(scrollbackTail);
  const promptZone = clean.slice(-PROMPT_ZONE_CHARS);
  const runWindow = clean.slice(-RUN_SCAN_CHARS);

  // 1. Waiting prompts win — Claude has an explicit (y/n) on screen.
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(promptZone)) return 'waiting';
  }

  // 2. Active processing wins next. "esc to interrupt" is the canonical signal
  //    and is present in BOTH the spinner area AND appended to the mode line
  //    during processing — so it must be checked before the idle marker
  //    (which is also rendered during processing on the same line).
  for (const pattern of RUNNING_PATTERNS) {
    if (pattern.test(runWindow)) return 'running';
  }

  // 3. Explicit idle markers — Claude's mode footer is the visible state
  //    when the TUI is sitting at its prompt (and "esc to interrupt" has
  //    been removed from the line).
  for (const pattern of IDLE_PATTERNS) {
    if (pattern.test(promptZone)) return 'idle';
  }

  // 4. Nothing recognized — fall back to idle.
  return 'idle';
}

/**
 * True when the tail contains one of Claude's TUI mode-footer strings.
 * Used by the always-on "demote running→idle" check to require positive
 * evidence (not mere absence of spinner) before flipping state, so quiet
 * tool calls don't flap.
 */
export function hasExplicitIdleMarker(scrollbackTail: string): boolean {
  if (!scrollbackTail) return false;
  const clean = stripAnsi(scrollbackTail);
  const promptZone = clean.slice(-PROMPT_ZONE_CHARS);
  return /(?:auto|plan|accept edits)\s+mode\s+on/i.test(promptZone)
    || /\(shift\+tab to cycle\)/i.test(promptZone);
}
