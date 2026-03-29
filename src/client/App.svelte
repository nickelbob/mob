<script lang="ts">
  import Dashboard from './components/Dashboard.svelte';
  import LaunchDialog from './components/LaunchDialog.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import { showLaunchDialog, showSettingsDialog, wsConnected, sortedInstances, visualInstances, selectedInstanceId, selectedInstance, sidebarCollapsed, errors, settings, wsClient, updateAvailable, updateStatus, updateError } from './lib/stores.js';
  import { matchesShortcut, formatShortcut } from './lib/shortcuts.js';

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  function cycleInstance(direction: number) {
    const list = $visualInstances;
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
    const s = $settings.shortcuts;
    if (matchesShortcut(e, s.launchDialog, isMac)) {
      e.preventDefault();
      showLaunchDialog.set(true);
    }
    if (matchesShortcut(e, s.toggleSidebar, isMac)) {
      e.preventDefault();
      sidebarCollapsed.update(v => !v);
    }
    if (matchesShortcut(e, s.cycleInstanceDown, isMac)) {
      e.preventDefault();
      cycleInstance(1);
      refocusTerminal();
    }
    if (matchesShortcut(e, s.cycleInstanceUp, isMac)) {
      e.preventDefault();
      cycleInstance(-1);
      refocusTerminal();
    }
    if (matchesShortcut(e, s.resumeInstance, isMac)) {
      e.preventDefault();
      const inst = $selectedInstance;
      if (inst && inst.managed && inst.state === 'stopped') {
        wsClient.send({ type: 'resume', payload: { instanceId: inst.id } });
      }
    }
    if (matchesShortcut(e, s.killInstance, isMac)) {
      e.preventDefault();
      const inst = $selectedInstance;
      if (inst && inst.managed && inst.state !== 'stopped') {
        if (confirm(`Kill instance "${inst.name}"?`)) {
          wsClient.send({ type: 'kill', payload: { instanceId: inst.id } });
        }
      }
    }
    if (matchesShortcut(e, s.dismissInstance, isMac)) {
      e.preventDefault();
      const inst = $selectedInstance;
      if (inst && inst.managed && inst.state === 'stopped') {
        wsClient.send({ type: 'dismiss', payload: { instanceId: inst.id } });
      }
    }
    if (matchesShortcut(e, s.openSettings, isMac)) {
      e.preventDefault();
      showSettingsDialog.update(v => !v);
    }
    // Jump to instance 1-9
    for (let i = 1; i <= 9; i++) {
      const key = `jumpToInstance${i}` as keyof typeof s;
      if (matchesShortcut(e, s[key], isMac)) {
        const list = $visualInstances;
        if (i - 1 < list.length) {
          e.preventDefault();
          selectedInstanceId.set(list[i - 1].id);
          refocusTerminal();
        }
        break;
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
      <button class="settings-btn" on:click={() => showSettingsDialog.set(true)} title="Settings">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="2.5"/>
          <path d="M13.5 8a5.5 5.5 0 00-.1-.8l1.3-1-.7-1.2-1.5.5a5.5 5.5 0 00-1.2-.7L11 3.3h-1.4l-.3 1.5a5.5 5.5 0 00-1.2.7l-1.5-.5-.7 1.2 1.3 1a5.5 5.5 0 000 1.6l-1.3 1 .7 1.2 1.5-.5c.3.3.7.5 1.2.7l.3 1.5H11l.3-1.5c.4-.2.8-.4 1.2-.7l1.5.5.7-1.2-1.3-1a5.5 5.5 0 00.1-.8z"/>
        </svg>
      </button>
      <button class="launch-btn" on:click={() => showLaunchDialog.set(true)}>
        + Launch Instance <kbd>{formatShortcut($settings.shortcuts.launchDialog, isMac)}</kbd>
      </button>
    </div>
  </header>
  {#if $updateAvailable}
    <div class="update-banner">
      {#if $updateStatus === 'installing'}
        <span class="update-text">Installing update...</span>
      {:else if $updateStatus === 'success'}
        <span class="update-text">Updated! Reconnecting...</span>
      {:else if $updateStatus === 'failed'}
        <span class="update-text">Update failed{$updateError ? `: ${$updateError}` : ''}. Run: <code>npm i -g mob-coordinator</code></span>
        <button class="update-dismiss" on:click={() => { updateAvailable.set(null); updateStatus.set('idle'); }}>×</button>
      {:else}
        <span class="update-text">Update available: v{$updateAvailable.current} → v{$updateAvailable.latest}</span>
        <button class="update-btn" on:click={() => {
          const active = $sortedInstances.filter(i => i.managed && i.state !== 'stopped').length;
          const msg = active > 0
            ? `${active} active session(s) will be terminated. Install update?`
            : 'Install update? The server will restart briefly.';
          if (confirm(msg)) wsClient.send({ type: 'update:install' });
        }}>Update now</button>
        <button class="update-dismiss" on:click={() => updateAvailable.set(null)}>×</button>
      {/if}
    </div>
  {/if}
  <Dashboard />
  {#if $showLaunchDialog}
    <LaunchDialog />
  {/if}
  {#if $showSettingsDialog}
    <SettingsDialog />
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

  .settings-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    padding: 5px 7px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s, border-color 0.15s;
  }

  .settings-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
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

  .update-banner {
    background: rgba(88, 166, 255, 0.1);
    border-bottom: 1px solid rgba(88, 166, 255, 0.3);
    padding: 6px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    color: var(--accent);
    flex-shrink: 0;
  }

  .update-text {
    flex: 1;
  }

  .update-text code {
    font-size: 12px;
    background: rgba(88, 166, 255, 0.15);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .update-btn {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 4px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: background 0.15s;
  }

  .update-btn:hover {
    background: var(--accent-hover);
  }

  .update-dismiss {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .update-dismiss:hover {
    color: var(--text-primary);
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
