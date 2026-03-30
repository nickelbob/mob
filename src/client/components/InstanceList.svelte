<script lang="ts">
  import InstanceCard from './InstanceCard.svelte';
  import { sortedInstances, groupedInstances, selectedInstanceId, collapsedGroups, wsClient } from '../lib/stores.js';

  $: resumableInstances = $sortedInstances.filter(
    (i) => i.managed && i.state === 'stopped'
  );

  // Show grouped view when 2+ groups exist OR any instance has an explicit project set
  $: useGrouped = $groupedInstances.length > 1 || $sortedInstances.some(i => !!i.project);

  // Determine which project group contains the selected instance
  $: selectedProject = (() => {
    const id = $selectedInstanceId;
    if (!id || !useGrouped) return null;
    for (const group of $groupedInstances) {
      if (group.instances.some(i => i.id === id)) return group.project;
    }
    return null;
  })();

  function toggleGroup(project: string) {
    collapsedGroups.update(g => ({ ...g, [project]: !g[project] }));
  }

  function resumeAll() {
    for (const instance of resumableInstances) {
      wsClient.send({ type: 'resume', payload: { instanceId: instance.id } });
    }
  }
</script>

<div class="instance-list">
  {#if $sortedInstances.length === 0}
    <div class="empty">
      <p>No instances</p>
      <p class="hint">Launch a new Claude instance or start one externally with hooks installed.</p>
    </div>
  {:else}
    {#if resumableInstances.length > 1}
      <button class="resume-all-btn" on:click={resumeAll}>
        Resume all ({resumableInstances.length})
      </button>
    {/if}

    {#if useGrouped}
      {#each $groupedInstances as group (group.project)}
        <div class="project-group">
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions a11y_no_static_element_interactions -->
          <div
            class="project-header"
            class:has-selected={$collapsedGroups[group.project] && selectedProject === group.project}
            on:click={() => toggleGroup(group.project)}
          >
            <span class="collapse-icon" class:collapsed={$collapsedGroups[group.project]}>&#9662;</span>
            <span class="project-name">{group.project}</span>
            <span class="project-count">{group.instances.length}</span>
          </div>
          {#if !$collapsedGroups[group.project]}
            {#each group.instances as instance (instance.id)}
              <InstanceCard {instance} />
            {/each}
          {/if}
        </div>
      {/each}
    {:else}
      {#each $sortedInstances as instance (instance.id)}
        <InstanceCard {instance} />
      {/each}
    {/if}
  {/if}
</div>

<style>
  .instance-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    overflow-y: auto;
    flex: 1;
  }

  .empty {
    text-align: center;
    padding: 32px 16px;
    color: var(--text-muted);
  }

  .empty p {
    margin-bottom: 8px;
  }

  .hint {
    font-size: 12px;
  }

  .resume-all-btn {
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 6px;
    color: var(--accent);
    border: 1px solid var(--accent);
    background: transparent;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    width: 100%;
  }

  .resume-all-btn:hover {
    background: rgba(88, 166, 255, 0.15);
  }

  .project-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .project-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    cursor: pointer;
    user-select: none;
    border-radius: 4px;
    transition: background 0.1s;
  }

  .project-header:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .project-header.has-selected {
    background: rgba(88, 166, 255, 0.12);
    border-left: 2px solid var(--accent);
    padding-left: 6px;
  }

  .project-header.has-selected .project-name {
    color: var(--accent);
  }

  .collapse-icon {
    font-size: 10px;
    color: var(--text-muted);
    transition: transform 0.15s;
    display: inline-block;
  }

  .collapse-icon.collapsed {
    transform: rotate(-90deg);
  }

  .project-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.3px;
    flex: 1;
  }

  .project-count {
    font-size: 10px;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.08);
    padding: 1px 6px;
    border-radius: 8px;
  }
</style>
