import { describe, it, expect } from 'vitest';
import {
  shellQuote,
  isValidModel,
  isValidPermissionMode,
  isValidSessionId,
  isValidInstanceId,
  isValidCwd,
  isValidName,
  stripControlChars,
  validateLaunchPayload,
  validateHookPayload,
} from '../util/sanitize.js';

describe('shellQuote', () => {
  it('wraps simple string in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('handles empty string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('neutralizes command injection attempts', () => {
    const malicious = '$(rm -rf /)';
    const quoted = shellQuote(malicious);
    expect(quoted).toBe("'$(rm -rf /)'");
    // Inside single quotes, $() is literal — not executed by the shell
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });

  it('neutralizes backtick injection', () => {
    expect(shellQuote('`whoami`')).toBe("'`whoami`'");
  });
});

describe('isValidModel', () => {
  it('accepts valid model names', () => {
    expect(isValidModel('claude-opus-4-6')).toBe(true);
    expect(isValidModel('claude-sonnet-4-6')).toBe(true);
    expect(isValidModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isValidModel('gpt-4o')).toBe(true);
    expect(isValidModel('model/v1.0')).toBe(true);
  });

  it('rejects injection attempts', () => {
    expect(isValidModel('$(rm -rf /)')).toBe(false);
    expect(isValidModel('model; echo pwned')).toBe(false);
    expect(isValidModel('model`whoami`')).toBe(false);
    expect(isValidModel('')).toBe(false);
  });

  it('rejects overly long values', () => {
    expect(isValidModel('a'.repeat(101))).toBe(false);
  });
});

describe('isValidPermissionMode', () => {
  it('accepts valid modes', () => {
    expect(isValidPermissionMode('default')).toBe(true);
    expect(isValidPermissionMode('plan')).toBe(true);
    expect(isValidPermissionMode('bypassPermissions')).toBe(true);
    expect(isValidPermissionMode('full')).toBe(true);
  });

  it('rejects invalid modes', () => {
    expect(isValidPermissionMode('$(evil)')).toBe(false);
    expect(isValidPermissionMode('admin')).toBe(false);
    expect(isValidPermissionMode('')).toBe(false);
  });
});

describe('isValidSessionId', () => {
  it('accepts valid session IDs', () => {
    expect(isValidSessionId('abc-123_def')).toBe(true);
    expect(isValidSessionId('session-id-001')).toBe(true);
  });

  it('rejects injection attempts', () => {
    expect(isValidSessionId('$(whoami)')).toBe(false);
    expect(isValidSessionId('id; rm -rf /')).toBe(false);
  });
});

describe('isValidCwd', () => {
  it('accepts absolute paths', () => {
    expect(isValidCwd('/home/user/project')).toBe(true);
    expect(isValidCwd('~/project')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isValidCwd('relative/path')).toBe(false);
    expect(isValidCwd('../escape')).toBe(false);
  });

  it('rejects null bytes', () => {
    expect(isValidCwd('/home/user\0/evil')).toBe(false);
  });

  it('rejects overly long paths', () => {
    expect(isValidCwd('/' + 'a'.repeat(1024))).toBe(false);
  });

  it('rejects empty', () => {
    expect(isValidCwd('')).toBe(false);
  });
});

describe('stripControlChars', () => {
  it('removes control characters', () => {
    expect(stripControlChars('hello\x00world')).toBe('helloworld');
    expect(stripControlChars('test\x1B[31m')).toBe('test[31m');
  });

  it('preserves newlines and tabs', () => {
    expect(stripControlChars('hello\nworld\ttab')).toBe('hello\nworld\ttab');
  });
});

describe('validateLaunchPayload', () => {
  it('accepts valid payload', () => {
    const result = validateLaunchPayload({
      cwd: '~/project',
      name: 'my-instance',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts minimal payload', () => {
    const result = validateLaunchPayload({ cwd: '/home/user' });
    expect(result.valid).toBe(true);
  });

  it('rejects missing cwd', () => {
    const result = validateLaunchPayload({ name: 'test' });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid model', () => {
    const result = validateLaunchPayload({ cwd: '/home', model: '$(evil)' });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid permissionMode', () => {
    const result = validateLaunchPayload({ cwd: '/home', permissionMode: 'hacker' });
    expect(result.valid).toBe(false);
  });

  it('rejects non-object payload', () => {
    expect(validateLaunchPayload(null).valid).toBe(false);
    expect(validateLaunchPayload('string').valid).toBe(false);
    expect(validateLaunchPayload(42).valid).toBe(false);
  });
});

describe('validateHookPayload', () => {
  it('accepts valid hook data', () => {
    const result = validateHookPayload({
      id: 'mob-abc123',
      cwd: '/home/user',
      state: 'running',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects missing id', () => {
    const result = validateHookPayload({ cwd: '/home', state: 'running' });
    expect(result.valid).toBe(false);
  });

  it('rejects overly long id', () => {
    const result = validateHookPayload({ id: 'a'.repeat(201) });
    expect(result.valid).toBe(false);
  });

  it('rejects null bytes in cwd', () => {
    const result = validateHookPayload({ id: 'test', cwd: '/home\0/evil' });
    expect(result.valid).toBe(false);
  });

  it('strips control chars from name', () => {
    const result = validateHookPayload({ id: 'test', name: 'hello\x00world' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.name).toBe('helloworld');
    }
  });
});
