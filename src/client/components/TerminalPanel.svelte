<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { Terminal } from 'xterm';
  import { FitAddon } from 'xterm-addon-fit';
  import { Unicode11Addon } from 'xterm-addon-unicode11';
  import { selectedInstance, selectedInstanceId, wsClient, wsConnected, onInstanceRemove, settings } from '../lib/stores.js';
  import { matchesShortcut } from '../lib/shortcuts.js';
  import type { InstanceInfo } from '../lib/types.js';

  let terminalEl: HTMLDivElement;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let currentSubscription: string | null = null;
  let unsubMessage: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeHandler: (() => void) | null = null;
  let inputDisposable: { dispose(): void } | null = null;
  let scrollDisposable: { dispose(): void } | null = null;
  let unsubRemove: (() => void) | null = null;
  let prevConnected = false;

  import { get } from 'svelte/store';

  // Cache terminals per instance (with LRU cap)
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- deliberately non-reactive
  const terminalCache = new Map<string, { terminal: Terminal; fitAddon: FitAddon }>();

  // SGR reset + home + erase display + erase scrollback. Unlike Terminal.clear()
  // this leaves row 1 empty (clear() keeps the cursor line, i.e. Claude's
  // prompt row) and unlike reset() it keeps alt-screen/mouse/bracketed-paste
  // modes, which the PTY still believes are active. The SGR reset is safe: the
  // replayed tail starts at an arbitrary chunk boundary, so the attribute
  // state before it is unknown either way, and the tail itself restores the
  // PTY's current attributes by the time it ends.
  const ERASE_SCREEN = '\x1b[m\x1b[H\x1b[2J\x1b[3J';

  // Track whether the active terminal is scrolled to bottom (default true)
  let isAtBottom = true;

  function checkIfAtBottom(t: Terminal): boolean {
    const buf = t.buffer.active;
    return buf.viewportY >= buf.baseY;
  }

  function scrollToBottomIfNeeded() {
    if (terminal && isAtBottom) {
      terminal.scrollToBottom();
    }
  }

  function evictOldestTerminal() {
    const max = get(settings).general.maxCachedTerminals;
    if (terminalCache.size <= max) return;
    // Map iteration is insertion order — evict first (oldest)
    const firstKey = terminalCache.keys().next().value;
    if (firstKey && firstKey !== currentSubscription) {
      const entry = terminalCache.get(firstKey);
      entry?.terminal.dispose();
      terminalCache.delete(firstKey);
    }
  }

  function disposeTerminalCache(instanceId: string) {
    const cached = terminalCache.get(instanceId);
    if (cached) {
      cached.terminal.dispose();
      terminalCache.delete(instanceId);
    }
  }

  function getOrCreateTerminal(instanceId: string): { terminal: Terminal; fitAddon: FitAddon } {
    let cached = terminalCache.get(instanceId);
    if (!cached) {
      const termSettings = get(settings).terminal;
      const t = new Terminal({
        cursorBlink: true,
        fontSize: termSettings.fontSize,
        cursorStyle: termSettings.cursorStyle,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        allowProposedApi: true,
        rightClickSelectsWord: true,
        theme: {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          selectionBackground: '#264f78',
          black: '#484f58',
          red: '#f85149',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#39d353',
          white: '#e6edf3',
          brightBlack: '#6e7681',
          brightRed: '#ffa198',
          brightGreen: '#56d364',
          brightYellow: '#e3b341',
          brightBlue: '#79c0ff',
          brightMagenta: '#d2a8ff',
          brightCyan: '#56d364',
          brightWhite: '#f0f6fc',
        },
        scrollback: termSettings.scrollbackLines,
      });
      const f = new FitAddon();
      t.loadAddon(f);
      // conhost/ConPTY lays out emoji as 2 cells; xterm's default Unicode 6
      // tables make them 1, shifting every column after one
      t.loadAddon(new Unicode11Addon());
      t.unicode.activeVersion = '11';
      cached = { terminal: t, fitAddon: f };
      terminalCache.set(instanceId, cached);
      evictOldestTerminal();
    }
    return cached;
  }

  let isStopped = false;

  // Claude's TUI enables mouse reporting (?1000/1002/1003h), which makes xterm
  // forward drags to the PTY instead of selecting — and xterm 5.x can't *start*
  // a selection via shift+drag either (incremental-click needs an existing
  // selection). So when mouse reporting is on, take over plain left-drags and
  // drive the selection API ourselves; plain clicks are replayed to xterm so
  // the TUI still gets them (permission prompts, menus).
  const selectionFixApplied = new WeakSet<Terminal>();

  function cellFromMouseEvent(t: Terminal, e: MouseEvent): { col: number; row: number } | null {
    const screen = t.element?.querySelector('.xterm-screen');
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const col = Math.max(0, Math.min(t.cols - 1, Math.floor(((e.clientX - r.left) / r.width) * t.cols)));
    const viewRow = Math.max(0, Math.min(t.rows - 1, Math.floor(((e.clientY - r.top) / r.height) * t.rows)));
    const buf = t.buffer.active;
    return { col, row: Math.min(buf.viewportY + viewRow, buf.length - 1) };
  }

  function selectWordAt(t: Terminal, cell: { col: number; row: number }) {
    const line = t.buffer.active.getLine(cell.row);
    if (!line) return;
    const text = line.translateToString();
    const isWord = (ch: string | undefined) => !!ch && !' \t()[]{}\'"`,;|'.includes(ch);
    if (!isWord(text[cell.col])) return;
    let start = cell.col;
    let end = cell.col;
    while (start > 0 && isWord(text[start - 1])) start--;
    while (end < text.length - 1 && isWord(text[end + 1])) end++;
    t.select(start, cell.row, end - start + 1);
  }

  function forceLocalSelection(t: Terminal) {
    if (!t.element || selectionFixApplied.has(t)) return;
    selectionFixApplied.add(t);
    // A replayed click makes Claude's TUI repaint, and that repaint clears any
    // selection made right after — so hold single-click replays briefly and
    // drop them when a second click follows (the user is selecting, not
    // clicking the TUI).
    let pendingClick: { replay: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

    // xterm clears its selection whenever it sends anything to the PTY, and
    // with any-motion tracking (?1003h) merely moving the mouse emits a
    // report — which would wipe the selection the instant the user moves
    // after releasing. Swallow motion/release events while a selection exists.
    for (const type of ['mousemove', 'mouseup'] as const) {
      t.element.addEventListener(type, (e: MouseEvent) => {
        if ((e as any).__mobForwarded) return;
        if (t.modes.mouseTrackingMode === 'none') return;
        if (t.hasSelection()) e.stopImmediatePropagation();
      }, true);
    }

    t.element.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e as any).__mobForwarded) return;
      // Without mouse reporting, xterm's native selection already works
      if (t.modes.mouseTrackingMode === 'none') return;
      if (e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      const anchor = cellFromMouseEvent(t, e);
      if (!anchor) return;
      e.preventDefault();
      e.stopImmediatePropagation();

      if (pendingClick) {
        clearTimeout(pendingClick.timer);
        const flush = e.detail === 1 ? pendingClick.replay : null;
        pendingClick = null;
        flush?.();
      }

      if (e.detail === 2) {
        selectWordAt(t, anchor);
        t.focus();
        return;
      }
      if (e.detail >= 3) {
        t.selectLines(anchor.row, anchor.row);
        t.focus();
        return;
      }

      let dragging = false;
      const applyDrag = (me: MouseEvent) => {
        const cur = cellFromMouseEvent(t, me);
        if (!cur) return;
        const [a, b] =
          cur.row < anchor.row || (cur.row === anchor.row && cur.col < anchor.col)
            ? [cur, anchor]
            : [anchor, cur];
        const length = (b.row - a.row) * t.cols + (b.col - a.col);
        if (length > 0) t.select(a.col, a.row, length);
        else t.clearSelection();
      };
      const onMove = (me: MouseEvent) => {
        me.stopImmediatePropagation();
        if (!dragging && Math.abs(me.clientX - e.clientX) < 4 && Math.abs(me.clientY - e.clientY) < 4) return;
        dragging = true;
        applyDrag(me);
      };
      const onUp = (ue: MouseEvent) => {
        ue.stopImmediatePropagation();
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        if (dragging) {
          applyDrag(ue);
        } else {
          // Plain click: replay it (after the multi-click window) so the TUI
          // still receives mouse clicks
          t.clearSelection();
          const replay = () => {
            pendingClick = null;
            for (const [type, src] of [['mousedown', e], ['mouseup', ue]] as const) {
              const clone = new MouseEvent(type, src);
              (clone as any).__mobForwarded = true;
              e.target?.dispatchEvent(clone);
            }
          };
          pendingClick = { replay, timer: setTimeout(replay, 300) };
        }
        t.focus();
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    }, true);
  }

  function attachTerminal(inst: InstanceInfo | null) {
    // Unsubscribe from previous
    if (currentSubscription) {
      wsClient.send({ type: 'terminal:unsubscribe', payload: { instanceId: currentSubscription } });
      if (terminal) {
        terminal.element?.remove();
      }
      // eslint-disable-next-line svelte/infinite-reactive-loop -- caller re-checks at execution time
      currentSubscription = null;
    }
    // Dispose previous input listener to prevent duplicate keystrokes
    if (inputDisposable) {
      inputDisposable.dispose();
      inputDisposable = null;
    }
    if (scrollDisposable) {
      scrollDisposable.dispose();
      scrollDisposable = null;
    }

    if (!inst || !inst.managed || !terminalEl) {
      terminal = null;
      fitAddon = null;
      isStopped = false;
      return;
    }

    isStopped = inst.state === 'stopped';

    const cached = getOrCreateTerminal(inst.id);
    terminal = cached.terminal;
    fitAddon = cached.fitAddon;

    // Clear container and attach — the container div exists only for xterm
    // eslint-disable-next-line svelte/no-dom-manipulating
    terminalEl.innerHTML = '';
    if (!terminal.element) {
      terminal.open(terminalEl);
    } else {
      // eslint-disable-next-line svelte/no-dom-manipulating
      terminalEl.appendChild(terminal.element);
    }

    fitAddon.fit();
    terminal.scrollToBottom();
    terminal.focus();
    forceLocalSelection(terminal);

    // Subscribe to output (also triggers scrollback for stopped instances)
    wsClient.send({ type: 'terminal:subscribe', payload: { instanceId: inst.id } });
    // eslint-disable-next-line svelte/infinite-reactive-loop -- caller re-checks at execution time
    currentSubscription = inst.id;

    if (!isStopped) {
      // Send resize
      wsClient.send({
        type: 'terminal:resize',
        payload: { instanceId: inst.id, cols: terminal.cols, rows: terminal.rows },
      });
    }

    // Handle keyboard shortcuts
    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Only intercept Alt combos that match a configured dashboard shortcut;
      // let others (e.g. Alt+M for Claude mode switch) pass through to the terminal
      if (e.altKey) {
        const isMac = navigator.platform.includes('Mac');
        const s = get(settings).shortcuts;
        for (const shortcut of Object.values(s)) {
          if (matchesShortcut(e, shortcut as string, isMac)) return false;
        }
      }
      if (e.ctrlKey && e.key === 'c' && terminal!.hasSelection()) {
        if (e.type === 'keydown') {
          navigator.clipboard.writeText(terminal!.getSelection());
          // Match Windows Terminal: copy clears the selection, so a second
          // Ctrl+C sends an interrupt
          terminal!.clearSelection();
        }
        return false;
      }
      if (e.ctrlKey && e.key === 'v') {
        if (e.type === 'keydown') {
          e.preventDefault();
          navigator.clipboard.readText().then((text) => {
            if (text && !isStopped && terminal) {
              // Use xterm's paste() so bracketed paste mode (\x1B[200~...\x1B[201~)
              // is applied when Claude has it enabled. Without this wrapping,
              // newlines in the pasted text get treated as Enter and each line
              // gets submitted as a separate prompt — only the last one survives.
              terminal.paste(text);
            }
          });
        }
        return false;
      }
      return true;
    });

    // Forward input (only for active instances)
    inputDisposable = terminal.onData((data) => {
      if (!isStopped) {
        wsClient.send({ type: 'terminal:input', payload: { instanceId: inst.id, data } });
      }
    });

    // Track scroll position to know if user scrolled up
    isAtBottom = true;
    scrollDisposable = terminal.onScroll(() => {
      if (terminal) {
        isAtBottom = checkIfAtBottom(terminal);
      }
    });
  }

  onMount(() => {
    unsubMessage = wsClient.onMessage((msg) => {
      if (msg.type === 'terminal:output' && msg.payload.instanceId === currentSubscription && terminal) {
        const wasAtBottom = isAtBottom;
        const savedY = terminal.buffer.active.viewportY;
        terminal.write(msg.payload.data);
        if (!wasAtBottom) {
          terminal.scrollToLine(savedY);
          isAtBottom = false;
        }
      }
      if (msg.type === 'terminal:scrollback' && msg.payload.instanceId === currentSubscription && terminal) {
        // One write keeps the erase ahead of the replay in xterm's write queue
        terminal.write(ERASE_SCREEN + msg.payload.data);
        scrollToBottomIfNeeded();
      }
      // Server promoted this tab to active viewer (the previous one left);
      // re-send our size so the PTY isn't stuck at the departed tab's.
      if (msg.type === 'terminal:resize-request' && msg.payload.instanceId === currentSubscription && terminal && fitAddon && !isStopped) {
        fitAddon.fit();
        wsClient.send({
          type: 'terminal:resize',
          payload: { instanceId: currentSubscription, cols: terminal.cols, rows: terminal.rows },
        });
      }
    });

    resizeObserver = new ResizeObserver(() => {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(() => {
        resizeDebounceTimer = null;
        fitAndSync('observer');
      }, 50);
    });

    // Clean up terminal cache when instances are removed
    unsubRemove = onInstanceRemove((instanceId) => {
      disposeTerminalCache(instanceId);
    });

    // Re-fit terminal when window moves between displays with different DPI
    resizeHandler = () => fitAndSync('window');
    window.addEventListener('resize', resizeHandler);
  });

  onDestroy(() => {
    unsubMessage?.();
    unsubRemove?.();
    inputDisposable?.dispose();
    scrollDisposable?.dispose();
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
    resizeObserver?.disconnect();
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    if (currentSubscription) {
      wsClient.send({ type: 'terminal:unsubscribe', payload: { instanceId: currentSubscription } });
    }
    for (const cached of terminalCache.values()) {
      cached.terminal.dispose();
    }
    terminalCache.clear();
    terminal = null;
    fitAddon = null;
  });

  // Observe whichever container div is currently rendered: the {#if} blocks
  // recreate it, and it may not exist yet at mount (snapshot not arrived)
  $: if (resizeObserver) {
    resizeObserver.disconnect();
    if (terminalEl) resizeObserver.observe(terminalEl);
  }

  // Only tell the PTY about a resize when fit() actually changed the grid;
  // ConPTY repaints the whole viewport on every resize it receives
  function fitAndSync(source: 'observer' | 'window' | 'settings') {
    if (!fitAddon || !terminal) return;
    const prevCols = terminal.cols;
    const prevRows = terminal.rows;
    fitAddon.fit();
    scrollToBottomIfNeeded();
    if (import.meta.env.DEV && source === 'observer') {
      const panel = terminalEl?.parentElement;
      console.debug('[terminal] observer fit', {
        rows: `${prevRows}->${terminal.rows}`,
        cols: `${prevCols}->${terminal.cols}`,
        containerHeight: terminalEl?.getBoundingClientRect().height,
        innerHeight: window.innerHeight,
        panelChildren: Array.from(panel?.children ?? []).map(
          (c) => `${c.className}:${(c as HTMLElement).offsetHeight}`,
        ),
      });
    }
    if (terminal.cols === prevCols && terminal.rows === prevRows) return;
    if (currentSubscription && !isStopped) {
      wsClient.send({
        type: 'terminal:resize',
        payload: { instanceId: currentSubscription, cols: terminal.cols, rows: terminal.rows },
      });
    }
  }

  // React to ID changes. Also react to instance managed/state becoming available
  // (e.g. snapshot arrives after ID was already set).
  // Use tick() so the {#if} block renders the terminal-container div before we attach.
  //
  // currentSubscription only updates inside attachTerminal, so a reactive
  // re-run during the tick() microtask (e.g. an instance:update for the same
  // id) would queue a second attach — a full unsubscribe/resubscribe that
  // clears and repaints the terminal. Re-check at execution time and read
  // fresh store values so queued duplicates no-op.
  $: {
    const id = $selectedInstanceId;
    void $selectedInstance;
    if (id !== currentSubscription) {
      tick().then(() => {
        if (get(selectedInstanceId) !== currentSubscription) {
          // eslint-disable-next-line svelte/infinite-reactive-loop -- guarded by the re-checks above
          attachTerminal(get(selectedInstance));
        }
      });
    }
  }
  // Keep isStopped in sync without re-attaching
  $: isStopped = $selectedInstance?.state === 'stopped';

  // Sync live-updatable options to all cached terminals when settings change.
  // Only the attached terminal gets fit() — detached cached terminals have no
  // DOM dimensions (fit() would compute bogus cols/rows); they re-fit on attach.
  $: {
    const fontSize = $settings.terminal.fontSize;
    const cursorStyle = $settings.terminal.cursorStyle;
    let changed = false;
    for (const [, cached] of terminalCache) {
      if (cached.terminal.options.fontSize !== fontSize) {
        cached.terminal.options.fontSize = fontSize;
        changed = true;
      }
      if (cached.terminal.options.cursorStyle !== cursorStyle) {
        cached.terminal.options.cursorStyle = cursorStyle;
      }
    }
    if (changed && terminal?.element?.isConnected) {
      fitAndSync('settings');
    }
  }

  // Re-subscribe terminal on WebSocket reconnect
  $: {
    const connected = $wsConnected;
    if (connected && !prevConnected && currentSubscription) {
      // The terminal:scrollback reply erases the screen before replaying
      wsClient.send({ type: 'terminal:subscribe', payload: { instanceId: currentSubscription } });
    }
    // eslint-disable-next-line no-useless-assignment -- read on the next reactive run
    prevConnected = connected;
  }
</script>

<div class="terminal-panel">
  {#if $selectedInstance}
    {#if $selectedInstance.managed}
      {#if $selectedInstance.state === 'stopped'}
        <div class="stopped-banner">Session ended</div>
      {:else if $selectedInstance.state === 'launching'}
        <div class="launching-banner">
          <span class="spinner"></span>
          Starting Claude...
        </div>
      {:else if $selectedInstance.state === 'waiting'}
        <div class="waiting-banner">
          <span class="pulse-dot"></span>
          Waiting for your input
        </div>
      {/if}
      {#if $selectedInstance.lastPrompt}
        <div class="last-prompt" title={$selectedInstance.lastPrompt}>
          <span class="last-prompt-label">Last prompt</span>
          <span class="last-prompt-text">{$selectedInstance.lastPrompt}</span>
        </div>
      {/if}
      <div class="terminal-container" bind:this={terminalEl}></div>
    {:else}
      <div class="external-info">
        <h3>External Instance</h3>
        <div class="info-grid">
          <span class="label">ID:</span><span>{$selectedInstance.id}</span>
          <span class="label">CWD:</span><span>{$selectedInstance.cwd}</span>
          {#if $selectedInstance.gitBranch}
            <span class="label">Branch:</span><span>{$selectedInstance.gitBranch}</span>
          {/if}
          <span class="label">State:</span><span>{$selectedInstance.state}</span>
          {#if $selectedInstance.currentTool}
            <span class="label">Tool:</span><span>{$selectedInstance.currentTool}</span>
          {/if}
          {#if $selectedInstance.model}
            <span class="label">Model:</span><span>{$selectedInstance.model}</span>
          {/if}
        </div>
        <p class="external-hint">
          This instance was started externally. Terminal I/O is only available for managed instances.
        </p>
      </div>
    {/if}
  {:else}
    <div class="no-selection">
      <p>Select an instance from the sidebar</p>
      <p class="hint">or launch a new one with the button above</p>
    </div>
  {/if}
</div>

<style>
  .terminal-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    overflow: hidden;
    position: relative;
  }

  .last-prompt {
    position: absolute;
    top: 8px;
    right: 16px;
    z-index: 10;
    max-width: 100ch;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    background: rgba(22, 27, 34, 0.94);
    border: 1px solid var(--border);
    border-radius: 6px;
    backdrop-filter: blur(4px);
    pointer-events: auto;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .last-prompt-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    font-weight: 600;
  }

  .last-prompt-text {
    font-size: 13px;
    line-height: 1.4;
    color: var(--text-primary);
    overflow: hidden;
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
  }

  /* Overlays, not flex siblings: panel chrome must never change the terminal row count */
  .waiting-banner,
  .stopped-banner,
  .launching-banner {
    position: absolute;
    top: 8px;
    left: 16px;
    z-index: 10;
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .waiting-banner {
    background: linear-gradient(rgba(210, 153, 34, 0.15), rgba(210, 153, 34, 0.15)), var(--bg-secondary);
    border-color: rgba(210, 153, 34, 0.3);
    color: var(--yellow);
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--yellow);
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .stopped-banner {
    background: linear-gradient(rgba(139, 148, 158, 0.15), rgba(139, 148, 158, 0.15)), var(--bg-secondary);
    color: var(--text-muted);
  }

  .launching-banner {
    background: linear-gradient(rgba(210, 153, 34, 0.1), rgba(210, 153, 34, 0.1)), var(--bg-secondary);
    color: var(--yellow);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(210, 153, 34, 0.3);
    border-top-color: var(--yellow);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .terminal-container {
    flex: 1;
    padding: 4px;
    overflow: hidden;
  }

  .terminal-container :global(.xterm) {
    height: 100%;
  }

  .no-selection, .external-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    gap: 8px;
  }

  .hint, .external-hint {
    font-size: 12px;
    color: var(--text-muted);
  }

  .external-info h3 {
    color: var(--text-primary);
    margin-bottom: 16px;
  }

  .info-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    font-size: 13px;
    max-width: 500px;
  }

  .label {
    color: var(--text-secondary);
    font-weight: 600;
  }

  .external-hint {
    margin-top: 24px;
    text-align: center;
    max-width: 300px;
  }
</style>
