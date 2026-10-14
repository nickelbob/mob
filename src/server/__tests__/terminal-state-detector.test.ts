import { describe, it, expect } from 'vitest';
import { detectStateFromTerminal, hasExplicitIdleMarker, stripAnsi } from '../terminal-state-detector.js';

// Captured from a real ~/.mob/scrollback log: OSC 8 hyperlink (ST-terminated)
// wrapping a PR number, then the mode line with a cursor-forward for the gap.
const REAL_OSC8_FOOTER =
  '\x1B]8;id=u-1nmor6d%17641221648059965505;https://github.com/example/repo/pull/3086\x1B\\'
  + '\x1B[4m#3086\x1B[38;2;153;153;153m\x1B]8;;\x1B\\\x1B[24m · esc\x1B[1Cto interrupt · ← for agents'
  + '\x1B[50;3H\x1B[?25h\x1B[?2026h\x1B[?2026l\x1B[?25l\x1B[m';

describe('stripAnsi', () => {
  it('keeps footer text after an ST-terminated OSC 8 hyperlink', () => {
    expect(stripAnsi(REAL_OSC8_FOOTER)).toBe('#3086 · esc to interrupt · ← for agents');
  });

  it('strips BEL-terminated OSC (window title)', () => {
    expect(stripAnsi('\x1B]0;claude — mob\x07> ')).toBe('> ');
  });

  it('does not run an ST-terminated OSC through to a later BEL', () => {
    const s = '\x1B]8;;https://x\x1B\\link\x1B]8;;\x1B\\ esc to interrupt\x1B]0;title\x07 tail';
    expect(stripAnsi(s)).toBe('link esc to interrupt tail');
  });

  it('leaves text after an unterminated OSC intact', () => {
    expect(stripAnsi('\x1B]8;;https://x')).toBe('\x1B]8;;https://x');
    expect(stripAnsi('\x1B]8;;https://x\x1B[m esc to interrupt')).toContain('esc to interrupt');
  });

  it('turns cursor-forward into a single space', () => {
    expect(stripAnsi('shift+tab\x1B[1Cto\x1B[12Ccycle')).toBe('shift+tab to cycle');
    expect(stripAnsi('a\x1B[Cb')).toBe('a b');
  });

  it('strips CSI with intermediates and private params', () => {
    expect(stripAnsi('\x1B[?25l\x1B[ q\x1B[>4;2m\x1B[38;2;1;2;3mx\x1B[49;3H\x1B[K')).toBe('x');
  });

  it('strips charset selection', () => {
    expect(stripAnsi('\x1B(Bx\x1B(0y')).toBe('xy');
  });
});

describe('detectStateFromTerminal', () => {
  it('detects running through an OSC 8 hyperlink and cursor-forward gap (real bytes)', () => {
    expect(detectStateFromTerminal(REAL_OSC8_FOOTER)).toBe('running');
  });

  it('detects running when an ST-terminated OSC precedes the footer and a BEL OSC follows', () => {
    const s = '\x1B]8;;https://claude.ai/code/session_x?from=cli\x1B\\/rc\x1B]8;;\x1B\\ esc to interrupt \x1B]0;title\x07';
    expect(detectStateFromTerminal(s)).toBe('running');
  });

  it('detects idle footer whose gaps are cursor-forward moves', () => {
    expect(detectStateFromTerminal('⏵⏵ auto\x1B[1Cmode\x1B[1Con (shift+tab\x1B[1Cto\x1B[1Ccycle)')).toBe('idle');
    expect(hasExplicitIdleMarker('⏵⏵ auto\x1B[1Cmode\x1B[1Con')).toBe(true);
  });

  // --- Empty / unrecognized defaults ---

  it('defaults to idle for empty string', () => {
    expect(detectStateFromTerminal('')).toBe('idle');
  });

  it('defaults to idle for null', () => {
    expect(detectStateFromTerminal(null as any)).toBe('idle');
  });

  it('defaults to idle for unrecognized text', () => {
    expect(detectStateFromTerminal('just some random text')).toBe('idle');
  });

  // --- Waiting patterns (prompt zone) ---

  it('detects waiting: y/n prompt', () => {
    expect(detectStateFromTerminal('Allow this? (y/n)')).toBe('waiting');
  });

  it('detects waiting: [y/n] brackets', () => {
    expect(detectStateFromTerminal('Allow tool use? [y/n]')).toBe('waiting');
  });

  it('detects waiting: Do you want to proceed', () => {
    expect(detectStateFromTerminal('Do you want to proceed?')).toBe('waiting');
  });

  // --- Running ---

  it('detects running: esc to interrupt (canonical signal)', () => {
    expect(detectStateFromTerminal('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt')).toBe('running');
  });

  it('detects running: esc to interrupt mid-stream', () => {
    expect(detectStateFromTerminal('whatever blah esc to interrupt blah')).toBe('running');
  });

  // --- Idle markers ---

  it('detects idle: auto mode footer (no esc-to-interrupt)', () => {
    expect(detectStateFromTerminal('⏵⏵ auto mode on (shift+tab to cycle)')).toBe('idle');
  });

  it('detects idle: plan mode footer', () => {
    expect(detectStateFromTerminal('⏵ plan mode on (shift+tab to cycle)')).toBe('idle');
  });

  it('detects idle: accept edits mode footer', () => {
    expect(detectStateFromTerminal('⏵⏵ accept edits mode on')).toBe('idle');
  });

  it('detects idle: bare > prompt on its own line', () => {
    expect(detectStateFromTerminal('some output\n> \n')).toBe('idle');
  });

  // --- Priority: waiting > running > idle ---

  it('waiting takes priority over running', () => {
    expect(detectStateFromTerminal('(y/n) esc to interrupt')).toBe('waiting');
  });

  it('running takes priority over idle marker (both on same mode line)', () => {
    // Real Claude TUI: during processing the mode line is "...(shift+tab) · esc to interrupt"
    expect(detectStateFromTerminal('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt')).toBe('running');
  });

  // --- False-positive prevention ---

  it('does NOT trigger running on bare verb words in prose', () => {
    expect(detectStateFromTerminal('thinking happens to be a word in this sentence')).toBe('idle');
  });

  it('does NOT trigger running on completion summary (✻ Cogitated for X)', () => {
    // Claude's *post*-thinking footer, not an active spinner
    expect(detectStateFromTerminal('✻ Cogitated for 1m 3s\n❯ \n⏵⏵ auto mode on (shift+tab to cycle)')).toBe('idle');
  });

  it('does NOT mistake stale "Cooking…" left in buffer after completion', () => {
    expect(detectStateFromTerminal('✢Cooking…81 Worked for 2m 30s\n⏵⏵ auto mode on (shift+tab to cycle)')).toBe('idle');
  });

  it('does NOT trigger running when esc-to-interrupt is past the recent window', () => {
    // Padding pushes "esc to interrupt" outside the RUN_SCAN_CHARS window
    const padding = 'x '.repeat(400);
    const output = 'esc to interrupt ' + padding + '\n⏵⏵ auto mode on (shift+tab to cycle)';
    expect(detectStateFromTerminal(output)).toBe('idle');
  });

  it('strips DEC private mode sequences before matching', () => {
    expect(detectStateFromTerminal('\x1B[?2026l esc to interrupt \x1B[?2026h')).toBe('running');
  });
});

describe('hasExplicitIdleMarker', () => {
  it('matches auto mode footer', () => {
    expect(hasExplicitIdleMarker('⏵⏵ auto mode on (shift+tab to cycle)')).toBe(true);
  });

  it('matches plan mode footer', () => {
    expect(hasExplicitIdleMarker('plan mode on')).toBe(true);
  });

  it('matches (shift+tab to cycle) hint alone', () => {
    expect(hasExplicitIdleMarker('something (shift+tab to cycle)')).toBe(true);
  });

  it('does not match generic running text without footer', () => {
    expect(hasExplicitIdleMarker('Cerebrating⠦  esc to interrupt')).toBe(false);
  });

  it('does not match empty', () => {
    expect(hasExplicitIdleMarker('')).toBe(false);
  });

  it('does not match marker that fell outside the prompt zone', () => {
    const padding = 'x'.repeat(700);
    expect(hasExplicitIdleMarker('auto mode on (shift+tab to cycle)' + padding)).toBe(false);
  });
});
