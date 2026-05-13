import { describe, it, expect } from 'vitest';
import { detectStateFromTerminal, hasExplicitIdleMarker } from '../terminal-state-detector.js';

describe('detectStateFromTerminal', () => {
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
