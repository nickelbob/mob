<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { Terminal } from 'xterm';
  import { FitAddon } from 'xterm-addon-fit';
  import { selectedInstance, selectedInstanceId, wsClient, wsConnected, onInstanceRemove, settings } from '../lib/stores.js';
  import type { InstanceInfo } from '../lib/types.js';

  let terminalEl: HTMLDivElement;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let currentSubscription: string | null = null;
  let unsubMessage: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeHandler: (() => void) | null = null;
  let inputDisposable: { dispose(): void } | null = null;
  let scrollDisposable: { dispose(): void } | null = null;
  let unsubRemove: (() => void) | null = null;
  let prevConnected = false;

  import { get } from 'svelte/store';

  // Cache terminals per instance (with LRU cap)
  const terminalCache = new Map<string, { terminal: Terminal; fitAddon: FitAddon }>();

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
        convertEol: true,
      });
      const f = new FitAddon();
      t.loadAddon(f);
      cached = { terminal: t, fitAddon: f };
      terminalCache.set(instanceId, cached);
      evictOldestTerminal();
    }
    return cached;
  }

  let isStopped = false;

  function attachTerminal(inst: InstanceInfo | null) {
    // Unsubscribe from previous
    if (currentSubscription) {
      wsClient.send({ type: 'terminal:unsubscribe', payload: { instanceId: currentSubscription } });
      if (terminal) {
        terminal.element?.remove();
      }
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

    // Clear container and attach
    terminalEl.innerHTML = '';
    if (!terminal.element) {
      terminal.open(terminalEl);
    } else {
      terminalEl.appendChild(terminal.element);
    }

    fitAddon.fit();
    terminal.scrollToBottom();
    terminal.focus();

    // Subscribe to output (also triggers scrollback for stopped instances)
    wsClient.send({ type: 'terminal:subscribe', payload: { instanceId: inst.id } });
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
      // Let Alt combos bubble to App.svelte for shortcuts
      if (e.altKey) return false;
      if (e.ctrlKey && e.key === 'c' && terminal!.hasSelection()) {
        navigator.clipboard.writeText(terminal!.getSelection());
        return false;
      }
      if (e.ctrlKey && e.key === 'v' && e.type === 'keydown') {
        navigator.clipboard.readText().then((text) => {
          if (text && !isStopped) {
            wsClient.send({ type: 'terminal:input', payload: { instanceId: inst.id, data: text } });
          }
        });
        return false;
      }
      if (e.ctrlKey && e.key === 'v' && e.type !== 'keydown') {
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
      if (msg.type === 'terminal:output' && msg.payload.instanceId === currentSubscription) {
        terminal?.write(msg.payload.data);
        scrollToBottomIfNeeded();
      }
      if (msg.type === 'terminal:scrollback' && msg.payload.instanceId === currentSubscription) {
        terminal?.write(msg.payload.data);
        scrollToBottomIfNeeded();
      }
    });

    resizeObserver = new ResizeObserver(() => {
      if (fitAddon && terminal) {
        fitAddon.fit();
        scrollToBottomIfNeeded();
        if (currentSubscription) {
          wsClient.send({
            type: 'terminal:resize',
            payload: { instanceId: currentSubscription, cols: terminal.cols, rows: terminal.rows },
          });
        }
      }
    });
    if (terminalEl) resizeObserver.observe(terminalEl);

    // Clean up terminal cache when instances are removed
    unsubRemove = onInstanceRemove((instanceId) => {
      disposeTerminalCache(instanceId);
    });

    // Re-fit terminal when window moves between displays with different DPI
    resizeHandler = () => {
      if (fitAddon && terminal) {
        fitAddon.fit();
        scrollToBottomIfNeeded();
        if (currentSubscription) {
          wsClient.send({
            type: 'terminal:resize',
            payload: { instanceId: currentSubscription, cols: terminal.cols, rows: terminal.rows },
          });
        }
      }
    };
    window.addEventListener('resize', resizeHandler);
  });

  onDestroy(() => {
    unsubMessage?.();
    unsubRemove?.();
    scrollDisposable?.dispose();
    resizeObserver?.disconnect();
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    if (currentSubscription) {
      wsClient.send({ type: 'terminal:unsubscribe', payload: { instanceId: currentSubscription } });
    }
  });

  // React to ID changes. Also react to instance managed/state becoming available
  // (e.g. snapshot arrives after ID was already set).
  // Use tick() so the {#if} block renders the terminal-container div before we attach.
  $: {
    const id = $selectedInstanceId;
    const inst = $selectedInstance;
    if (id !== currentSubscription) {
      tick().then(() => attachTerminal(inst));
    }
  }
  // Keep isStopped in sync without re-attaching
  $: isStopped = $selectedInstance?.state === 'stopped';

  // Update font size on all cached terminals when settings change
  $: {
    const fontSize = $settings.terminal.fontSize;
    for (const [, cached] of terminalCache) {
      if (cached.terminal.options.fontSize !== fontSize) {
        cached.terminal.options.fontSize = fontSize;
        cached.fitAddon.fit();
      }
    }
    scrollToBottomIfNeeded();
  }

  // Re-subscribe terminal on WebSocket reconnect
  $: {
    const connected = $wsConnected;
    if (connected && !prevConnected && currentSubscription) {
      wsClient.send({ type: 'terminal:subscribe', payload: { instanceId: currentSubscription } });
    }
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
  }

  .waiting-banner {
    padding: 6px 12px;
    background: rgba(210, 153, 34, 0.15);
    border-bottom: 1px solid rgba(210, 153, 34, 0.3);
    color: var(--yellow);
    font-size: 12px;
    text-align: center;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
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
    padding: 6px 12px;
    background: rgba(139, 148, 158, 0.15);
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12px;
    text-align: center;
    font-weight: 600;
  }

  .launching-banner {
    padding: 6px 12px;
    background: rgba(210, 153, 34, 0.1);
    border-bottom: 1px solid var(--border);
    color: var(--yellow);
    font-size: 12px;
    text-align: center;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
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
