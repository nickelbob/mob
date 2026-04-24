import { describe, it, expect } from 'vitest';
import { detectStateFromTerminal } from '../terminal-state-detector.js';

describe('detectStateFromTerminal', () => {
  it('returns null for empty string', () => {
    expect(detectStateFromTerminal('')).toBe(null);
  });

  it('returns null for null/undefined', () => {
    expect(detectStateFromTerminal(null as any)).toBe(null);
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

  // --- Running patterns ---

  it('detects running: esc to interrupt', () => {
    expect(detectStateFromTerminal('Working... esc to interrupt')).toBe('running');
  });

  it('detects running: thinking text', () => {
    expect(detectStateFromTerminal('thinking with max effort')).toBe('running');
  });

  it('detects running: Ruminating', () => {
    expect(detectStateFromTerminal('Ruminating…')).toBe('running');
  });

  // --- Idle patterns ---

  it('detects idle: > prompt', () => {
    expect(detectStateFromTerminal('some output\n> ')).toBe('idle');
  });

  it('detects idle: $ prompt', () => {
    expect(detectStateFromTerminal('some output\n$ ')).toBe('idle');
  });

  it('returns null for unrecognized text', () => {
    expect(detectStateFromTerminal('just some random text')).toBe(null);
  });

  // --- Priority tests ---

  it('waiting takes priority over running', () => {
    expect(detectStateFromTerminal('Allow Bash? (y/n) thinking')).toBe('waiting');
  });

  // --- False positive prevention ---

  it('does NOT false-detect waiting from bare "allow"', () => {
    expect(detectStateFromTerminal('Allow tool use?')).toBe(null);
  });

  it('does NOT false-detect waiting from bare "approve"', () => {
    expect(detectStateFromTerminal('Please approve this action')).toBe(null);
  });

  it('does NOT false-detect waiting from "allow" in response body', () => {
    const longOutput = 'I updated the code to allow users to reset passwords. '.repeat(10) + '\n> ';
    expect(detectStateFromTerminal(longOutput)).toBe('idle');
  });

  it('does NOT false-detect waiting from "approve" in response body', () => {
    const output = 'The PR was approved and merged. Changes look good.\n'.repeat(5) + '\n> ';
    expect(detectStateFromTerminal(output)).toBe('idle');
  });

  it('does NOT false-detect waiting from "accept" in code output', () => {
    const output = 'function accept(conn) { /* handle connection */ }\nmodule.exports = { accept };\n'.repeat(5) + '\n> ';
    expect(detectStateFromTerminal(output)).toBe('idle');
  });

  it('strips DEC private mode sequences', () => {
    const output = '\x1B[?2026lthinking with max effort\x1B[?2026h';
    expect(detectStateFromTerminal(output)).toBe('running');
  });
});
