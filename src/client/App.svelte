<script lang="ts">
  import Dashboard from './components/Dashboard.svelte';
  import LaunchDialog from './components/LaunchDialog.svelte';
  import { showLaunchDialog, wsConnected, sortedInstances, selectedInstanceId, sidebarCollapsed, errors } from './lib/stores.js';

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

  function handleMousedown(e: MouseEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    // Don't steal focus from interactive elements or the launch dialog
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    if ((e.target as HTMLElement)?.closest('.overlay')) return;
    refocusTerminal();
  }

  function handleKeydown(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      showLaunchDialog.set(true);
    }
    if (e.altKey && e.code === 'KeyB') {
      e.preventDefault();
      sidebarCollapsed.update(v => !v);
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

<svelte:window on:keydown={handleKeydown} on:mousedown={handleMousedown} />

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
  {#if $errors.length > 0}
    <div class="error-toast-container">
      {#each $errors.slice(-3) as err (err.timestamp)}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="error-toast" on:click={() => errors.update(e => e.filter(x => x !== err))}>
          {err.message}
          {#if err.context}
            <span class="error-context">{err.context}</span>
          {/if}
        </div>
      {/each}
    </div>
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

  .error-toast-container {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 400px;
  }

  .error-toast {
    background: rgba(248, 81, 73, 0.15);
    border: 1px solid rgba(248, 81, 73, 0.4);
    color: var(--red);
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    animation: toast-slide-in 0.3s ease;
  }

  .error-context {
    display: block;
    font-size: 11px;
    opacity: 0.7;
    margin-top: 4px;
  }

  @keyframes toast-slide-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
