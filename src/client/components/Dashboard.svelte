<script lang="ts">
  import InstanceList from './InstanceList.svelte';
  import TerminalPanel from './TerminalPanel.svelte';
  import { selectedInstance, selectedInstanceId, sidebarCollapsed } from '../lib/stores.js';

  let toast: { name: string; branch?: string; cwd: string } | null = null;
  let toastKey = 0;
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;
  let prevInstanceId: string | null = null;

  function showToast(inst: { name: string; gitBranch?: string; cwd: string }) {
    if (toastTimeout) clearTimeout(toastTimeout);
    toastKey++;
    toast = { name: inst.name, branch: inst.gitBranch, cwd: inst.cwd };
    toastTimeout = setTimeout(() => { toast = null; }, 2000);
  }

  $: {
    const id = $selectedInstanceId;
    const inst = $selectedInstance;
    if ($sidebarCollapsed && inst && id !== prevInstanceId) {
      showToast(inst);
    }
    prevInstanceId = id;
  }
</script>

<div class="dashboard">
  <aside class="sidebar" class:collapsed={$sidebarCollapsed}>
    <div class="sidebar-content">
      <InstanceList />
    </div>
    <button class="collapse-toggle" on:click={() => sidebarCollapsed.update(v => !v)} title={$sidebarCollapsed ? 'Expand sidebar (Alt+B)' : 'Collapse sidebar (Alt+B)'}>
      <span class="collapse-icon">{$sidebarCollapsed ? '›' : '‹'}</span>
    </button>
  </aside>
  <main class="main-area">
    {#if toast}
      {#key toastKey}
        <div class="instance-toast">
          <div class="toast-name">{toast.name}</div>
          {#if toast.branch}
            <div class="toast-detail">{toast.branch}</div>
          {/if}
          <div class="toast-detail">{toast.cwd}</div>
        </div>
      {/key}
    {/if}
    <TerminalPanel />
  </main>
</div>

<style>
  .dashboard {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .sidebar {
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
    border-right: 1px solid var(--border);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: row;
    overflow: hidden;
    transition: width 0.2s ease, min-width 0.2s ease;
    position: relative;
  }

  .sidebar.collapsed {
    width: 28px;
    min-width: 28px;
  }

  .sidebar-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar.collapsed .sidebar-content {
    display: none;
  }

  .collapse-toggle {
    width: 28px;
    min-width: 28px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-size: 16px;
    transition: color 0.15s;
  }

  .collapse-toggle:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  .collapse-icon {
    line-height: 1;
  }

  .main-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  .instance-toast {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 14px;
    z-index: 100;
    pointer-events: none;
    animation: toast-fade 2s ease forwards;
    max-width: 400px;
    text-align: center;
  }

  .toast-name {
    font-weight: 600;
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .toast-detail {
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }

  @keyframes toast-fade {
    0% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
    10% { opacity: 1; transform: translateX(-50%) translateY(0); }
    80% { opacity: 1; }
    100% { opacity: 0; }
  }
</style>
