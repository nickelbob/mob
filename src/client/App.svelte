<script lang="ts">
  import Dashboard from './components/Dashboard.svelte';
  import LaunchDialog from './components/LaunchDialog.svelte';
  import { showLaunchDialog, wsConnected, sortedInstances, selectedInstanceId } from './lib/stores.js';

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  function cycleInstance(direction: number) {
    const list = $sortedInstances;
    if (list.length === 0) return;
    const currentIndex = list.findIndex(i => i.id === $selectedInstanceId);
    let next: number;
    if (currentIndex === -1) {
      next = 0;
    } else {
      next = (currentIndex + direction + list.length) % list.length;
    }
    selectedInstanceId.set(list[next].id);
  }

  function refocusTerminal() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.terminal-container textarea') as HTMLElement;
      el?.focus();
    });
  }

  function handleKeydown(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.altKey && e.key === 'n') {
      e.preventDefault();
      showLaunchDialog.set(true);
    }
    // Alt+ArrowDown / Alt+ArrowUp to cycle sessions
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      cycleInstance(1);
      refocusTerminal();
    }
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      cycleInstance(-1);
      refocusTerminal();
    }
    // Ctrl+1-9 to jump to session by index
    if (mod && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      const list = $sortedInstances;
      if (idx < list.length) {
        e.preventDefault();
        selectedInstanceId.set(list[idx].id);
        refocusTerminal();
      }
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<main>
  <header>
    <div class="logo">
      <span class="logo-text">mob</span>
      <span class="logo-sub">claude coordinator</span>
    </div>
    <div class="header-actions">
      <span class="connection-status" class:connected={$wsConnected}>
        {$wsConnected ? 'Connected' : 'Disconnected'}
      </span>
      <button class="launch-btn" on:click={() => showLaunchDialog.set(true)}>
        + Launch Instance <kbd>Alt+N</kbd>
      </button>
    </div>
  </header>
  <Dashboard />
  {#if $showLaunchDialog}
    <LaunchDialog />
  {/if}
</main>

<style>
  main {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    height: var(--header-height);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    flex-shrink: 0;
  }

  .logo {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .logo-text {
    font-size: 18px;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.5px;
  }

  .logo-sub {
    font-size: 12px;
    color: var(--text-muted);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .connection-status {
    font-size: 12px;
    color: var(--red);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .connection-status::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--red);
  }

  .connection-status.connected {
    color: var(--green);
  }

  .connection-status.connected::before {
    background: var(--green);
  }

  .launch-btn {
    background: var(--accent);
    color: #fff;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    transition: background 0.15s;
  }

  .launch-btn:hover {
    background: var(--accent-hover);
  }

  .launch-btn kbd {
    font-family: inherit;
    font-size: 11px;
    opacity: 0.7;
    margin-left: 4px;
  }
</style>
