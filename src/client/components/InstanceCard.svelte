<script lang="ts">
  import type { InstanceInfo } from '../lib/types.js';
  import StatusBadge from './StatusBadge.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import { selectedInstanceId, wsClient } from '../lib/stores.js';

  export let instance: InstanceInfo;

  $: selected = $selectedInstanceId === instance.id;
  $: needsInput = instance.state === 'waiting';

  function select() {
    selectedInstanceId.set(instance.id);
  }

  function kill(e: Event) {
    e.stopPropagation();
    if (confirm(`Kill instance "${instance.name}"?`)) {
      wsClient.send({ type: 'kill', payload: { instanceId: instance.id } });
    }
  }

  function resume(e: Event) {
    e.stopPropagation();
    wsClient.send({ type: 'resume', payload: { instanceId: instance.id } });
  }

  function dismiss(e: Event) {
    e.stopPropagation();
    wsClient.send({ type: 'dismiss', payload: { instanceId: instance.id } });
  }

  function shortPath(p: string): string {
    const home = '~';
    // Simple home dir replacement (Linux + macOS)
    return p.replace(/^\/root/, home).replace(/^\/home\/\w+/, home).replace(/^\/Users\/\w+/, home);
  }
</script>

<div class="card" class:selected class:needs-input={needsInput} on:click={select} on:mousedown|preventDefault role="button" tabindex="-1" on:keypress={select}>
  <div class="card-header">
    <span class="name">{instance.name}</span>
    <StatusBadge state={instance.state} />
  </div>

  <div class="card-meta">
    {#if instance.gitBranch}
      <span class="meta-item branch">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z"/></svg>
        {instance.gitBranch}
      </span>
    {/if}
    <span class="meta-item cwd" title={instance.cwd}>{shortPath(instance.cwd)}</span>
  </div>

  {#if instance.ticket || instance.subtask}
    <div class="card-task">
      {#if instance.ticket}
        {#if instance.ticketUrl}
          <a class="ticket ticket-link" href={instance.ticketUrl} target="_blank" rel="noopener"
             on:click|stopPropagation>{instance.ticket}</a>
        {:else}
          <span class="ticket">{instance.ticket}</span>
        {/if}
        {#if instance.ticketStatus}
          <span class="ticket-status">{instance.ticketStatus}</span>
        {/if}
      {/if}
      {#if instance.subtask}<span class="subtask">{instance.subtask}</span>{/if}
    </div>
  {/if}

  {#if instance.currentTool}
    <div class="current-tool">Using: {instance.currentTool}</div>
  {/if}

  <ProgressBar progress={instance.progress} />

  <div class="card-footer">
    <span class="badge-type" title={instance.managed ? 'Launched and controlled by mob' : 'Discovered externally via hooks'}>{instance.managed ? 'managed' : 'external'}</span>
    <div class="card-actions">
      {#if instance.managed && instance.state === 'stopped'}
        <button class="resume-btn" on:click={resume} title="Resume session">Resume</button>
        <button class="dismiss-btn" on:click={dismiss} title="Dismiss">✕</button>
      {:else if instance.managed && instance.state !== 'stopped'}
        <button class="kill-btn" on:click={kill} title="Kill instance">✕</button>
      {:else if !instance.managed}
        <button class="dismiss-btn" on:click={dismiss} title="Dismiss">✕</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .card {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
    background: var(--bg-secondary);
  }

  .card:hover {
    border-color: var(--text-muted);
  }

  .card.selected {
    border-color: var(--accent);
    background: rgba(88, 166, 255, 0.05);
  }

  .card.needs-input {
    border-left: 3px solid var(--yellow);
    animation: attention 2s ease-in-out infinite;
  }

  @keyframes attention {
    0%, 100% { border-left-color: var(--yellow); }
    50% { border-left-color: transparent; }
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .name {
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 4px;
  }

  .meta-item {
    font-size: 11px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-task {
    display: flex;
    gap: 6px;
    margin-bottom: 4px;
    flex-wrap: wrap;
  }

  .ticket {
    font-size: 11px;
    color: var(--purple);
    background: rgba(188, 140, 255, 0.1);
    padding: 1px 6px;
    border-radius: 4px;
  }

  .ticket-link {
    text-decoration: none;
    cursor: pointer;
  }

  .ticket-link:hover {
    text-decoration: underline;
  }

  .ticket-status {
    font-size: 10px;
    color: var(--text-muted);
    background: rgba(139, 148, 158, 0.15);
    padding: 1px 6px;
    border-radius: 4px;
  }

  .subtask {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .current-tool {
    font-size: 11px;
    color: var(--yellow);
    margin-bottom: 2px;
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
  }

  .badge-type {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .kill-btn {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-muted);
    transition: all 0.15s;
  }

  .kill-btn:hover {
    background: rgba(248, 81, 73, 0.2);
    color: var(--red);
  }

  .card-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .resume-btn {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    color: var(--accent);
    border: 1px solid var(--accent);
    background: transparent;
    font-weight: 600;
    transition: all 0.15s;
  }

  .resume-btn:hover {
    background: rgba(88, 166, 255, 0.15);
  }

  .dismiss-btn {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-muted);
    transition: all 0.15s;
  }

  .dismiss-btn:hover {
    background: rgba(139, 148, 158, 0.2);
    color: var(--text-secondary);
  }
</style>
