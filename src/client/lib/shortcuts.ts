interface ParsedShortcut {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  code: string;
}

export function parseShortcut(str: string): ParsedShortcut {
  const parts = str.split('+');
  const code = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase());
  return {
    alt: modifiers.includes('alt'),
    ctrl: modifiers.includes('ctrl'),
    meta: modifiers.includes('meta'),
    shift: modifiers.includes('shift'),
    code,
  };
}

export function matchesShortcut(event: KeyboardEvent, shortcutStr: string, isMac: boolean): boolean {
  const parsed = parseShortcut(shortcutStr);
  const hasMod = shortcutStr.includes('Mod+');

  // Check modifiers
  if (parsed.alt !== event.altKey) return false;
  if (parsed.shift !== event.shiftKey) return false;

  if (hasMod) {
    // Mod = Meta on Mac, Ctrl on others
    const modKey = isMac ? event.metaKey : event.ctrlKey;
    if (!modKey) return false;
    // Ensure the other modifier is NOT pressed (unless explicitly required)
    if (isMac && event.ctrlKey && !parsed.ctrl) return false;
    if (!isMac && event.metaKey && !parsed.meta) return false;
  } else {
    if (parsed.ctrl !== event.ctrlKey) return false;
    if (parsed.meta !== event.metaKey) return false;
  }

  // Check code — for arrow keys, match on event.key instead
  if (parsed.code.startsWith('Arrow')) {
    return event.key === parsed.code;
  }
  return event.code === parsed.code;
}

export function eventToShortcut(event: KeyboardEvent, isMac: boolean): string {
  const parts: string[] = [];
  if (event.ctrlKey && !isMac) parts.push('Mod');
  else if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey && isMac) parts.push('Mod');
  else if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  // Don't capture bare modifier keys
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return '';

  parts.push(event.code);
  return parts.join('+');
}

const CODE_DISPLAY: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

export function formatShortcut(str: string, isMac: boolean): string {
  return str
    .replace(/Mod\+/g, isMac ? 'Cmd+' : 'Ctrl+')
    .replace(/Key([A-Z])/g, '$1')
    .replace(/Digit(\d)/g, '$1')
    .replace(/Arrow(Up|Down|Left|Right)/g, (_m, dir) => CODE_DISPLAY[`Arrow${dir}`] || dir);
}
