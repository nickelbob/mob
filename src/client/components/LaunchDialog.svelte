<script lang="ts">
  import { onDestroy } from 'svelte';
  import { showLaunchDialog, wsClient, settings, launchConflicts, instances } from '../lib/stores.js';
  import { get } from 'svelte/store';
  import type { LaunchConflicts } from '../lib/types.js';

  const launchDefaults = get(settings).launch;
  let name = '';
  let autoName = launchDefaults.autoName;
  let cwd = launchDefaults.cwd;
  let project = '';
  let model = launchDefaults.model;
  let permissionMode = launchDefaults.permissionMode;

  // Autocomplete state
  let suggestions: Array<{ path: string; display: string }> = [];
  let showSuggestions = false;
  let selectedSuggestion = -1;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

  async function fetchSuggestions(query: string) {
    if (!query || query.length < 2) {
      suggestions = [];
      showSuggestions = false;
      return;
    }
    // Abort any in-flight request
    abortController?.abort();
    abortController = new AbortController();
    try {
      const res = await fetch(`/api/completions/dirs?q=${encodeURIComponent(query)}`, {
        signal: abortController.signal,
      });
      suggestions = await res.json();
      showSuggestions = suggestions.length > 0;
      selectedSuggestion = -1;
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        suggestions = [];
        showSuggestions = false;
      }
    }
  }

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    abortController?.abort();
    unsubConflicts();
  });

  function onCwdInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchSuggestions(cwd), 150);
  }

  function selectSuggestion(s: { path: string; display: string }) {
    cwd = s.display;
    showSuggestions = false;
    selectedSuggestion = -1;
    // Fetch next level
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchSuggestions(cwd), 150);
  }

  function handleCwdKeydown(e: KeyboardEvent) {
    if (!showSuggestions) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedSuggestion = Math.min(selectedSuggestion + 1, suggestions.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedSuggestion = Math.max(selectedSuggestion - 1, -1);
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (selectedSuggestion >= 0 && selectedSuggestion < suggestions.length) {
        e.preventDefault();
        selectSuggestion(suggestions[selectedSuggestion]);
      } else if (e.key === 'Tab' && suggestions.length > 0) {
        e.preventDefault();
        selectSuggestion(suggestions[0]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      showSuggestions = false;
    }
  }

  // Conflict state
  let conflicts: LaunchConflicts | null = null;
  let showConflictWarning = false;
  let showCwdMissing = false;
  let cloneDir = '';
  let showCloneInput = false;

  // Subscribe to conflict responses
  const unsubConflicts = launchConflicts.subscribe((c) => {
    if (!c) return;
    if (!c.cwdExists) {
      showCwdMissing = true;
      conflicts = c;
    } else if (c.sameDirInstances.length > 0 || c.sameBranchInstances.length > 0) {
      conflicts = c;
      showConflictWarning = true;
      // Pre-fill clone dir
      const base = cwd.trim().replace(/\/+$/, '');
      cloneDir = `${base}-${Date.now().toString(36).slice(-4)}`;
    } else {
      // No conflicts — proceed with launch
      doLaunch();
    }
    launchConflicts.set(null);
  });

  function buildPayload(extra?: { cloneDir?: string; createDir?: boolean }) {
    return {
      name: autoName ? '' : (name.trim() || `Instance ${Date.now().toString(36)}`),
      autoName,
      cwd: cwd.trim(),
      project: project.trim() || undefined,
      model: model || undefined,
      permissionMode: permissionMode || undefined,
      ...extra,
    };
  }

  function launch() {
    if (!cwd.trim()) {
      alert('Working directory is required');
      return;
    }
    // Check for conflicts first
    wsClient.send({
      type: 'launch:check',
      payload: buildPayload(),
    });
  }

  function doLaunch(extra?: { cloneDir?: string; createDir?: boolean }) {
    wsClient.send({
      type: 'launch',
      payload: buildPayload(extra),
    });
    showLaunchDialog.set(false);
    reset();
  }

  function launchAnyway() {
    showConflictWarning = false;
    conflicts = null;
    doLaunch();
  }

  function launchWithClone() {
    if (!cloneDir.trim()) {
      alert('Clone directory is required');
      return;
    }
    showConflictWarning = false;
    conflicts = null;
    doLaunch({ cloneDir: cloneDir.trim() });
  }

  function createDirAndLaunch() {
    showCwdMissing = false;
    conflicts = null;
    doLaunch({ createDir: true });
  }

  function cancelMissing() {
    showCwdMissing = false;
    conflicts = null;
  }

  function cancelConflict() {
    showConflictWarning = false;
    showCloneInput = false;
    conflicts = null;
  }

  function cancel() {
    showLaunchDialog.set(false);
    reset();
  }

  function reset() {
    const defaults = get(settings).launch;
    name = '';
    autoName = defaults.autoName;
    cwd = defaults.cwd;
    project = '';
    model = defaults.model;
    permissionMode = defaults.permissionMode;
    suggestions = [];
    showSuggestions = false;
    conflicts = null;
    showConflictWarning = false;
    showCwdMissing = false;
    showCloneInput = false;
    cloneDir = '';
  }

  let browsing = false;
  let canBrowse = false;

  // Hide browse button on Windows (native dialog locks the browser)
  fetch('/api/platform').then(r => r.json()).then(d => {
    canBrowse = d.platform !== 'win32';
  }).catch(() => {});

  async function browseDir() {
    browsing = true;
    try {
      const res = await fetch('/api/browse-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDir: cwd || '~' }),
      });
      const data = await res.json();
      if (data.path) {
        cwd = data.path;
        showSuggestions = false;
      }
    } catch { /* ignore */ }
    browsing = false;
  }

  function autofocus(node: HTMLInputElement) {
    // Force-clear any browser autofill after a frame, then focus
    requestAnimationFrame(() => {
      if (node.value && !get(settings).launch.cwd) {
        node.value = '';
        cwd = '';
      }
      node.focus();
    });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter' && e.ctrlKey) launch();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
<div class="overlay" on:click={cancel} role="dialog" tabindex="-1">
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div class="dialog" on:click|stopPropagation={() => { showSuggestions = false; }} role="document">
    <h2>Launch Claude Instance</h2>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <form autocomplete="off" on:submit|preventDefault={launch}>

    <div class="field">
      <label for="mob-launch-cwd">Working Directory *</label>
      <div class="autocomplete-wrap">
        <div class="input-with-browse">
          <input
            id="mob-launch-cwd"
            name="mob-launch-cwd"
            type="text"
            bind:value={cwd}
            on:input={onCwdInput}
            on:keydown={handleCwdKeydown}
            on:focus={() => { if (suggestions.length) showSuggestions = true; }}
            on:blur={() => { setTimeout(() => showSuggestions = false, 200); }}
            placeholder="~/Development/my-project"
            autocomplete="off"
            data-form-type="other"
            data-lpignore="true"
            use:autofocus
          />
          {#if canBrowse}
            <button type="button" class="browse-btn" on:click={browseDir} disabled={browsing} title="Browse for folder">
              {#if browsing}
                ...
              {:else}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5A1 1 0 005.8 3H3a1 1 0 00-1 1z"/>
                </svg>
              {/if}
            </button>
          {/if}
        </div>
        {#if showSuggestions}
          <ul class="suggestions">
            {#each suggestions as s, i}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
              <li
                class:selected={i === selectedSuggestion}
                on:mousedown={() => selectSuggestion(s)}
              >
                {s.display}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>

    <div class="field">
      <label for="mob-launch-project">Project / Group</label>
      <input id="mob-launch-project" type="text" bind:value={project} placeholder="(auto-detected from repo)" />
    </div>

    <div class="field">
      <div class="name-header">
        <label for="name">Name</label>
        <label class="toggle-label">
          <input type="checkbox" bind:checked={autoName} />
          <span>Let Claude decide</span>
        </label>
      </div>
      {#if !autoName}
        <input id="name" type="text" bind:value={name} placeholder="my-feature" />
      {:else}
        <p class="auto-name-hint">Claude will name this instance based on what it's working on</p>
      {/if}
    </div>

    <div class="field-row">
      <div class="field">
        <label for="model">Model</label>
        <select id="model" bind:value={model}>
          <option value="">Default</option>
          <option value="claude-opus-4-6">Opus 4.6</option>
          <option value="claude-sonnet-4-6">Sonnet 4.6</option>
          <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
        </select>
      </div>

      <div class="field">
        <label for="perm">Permission Mode</label>
        <select id="perm" bind:value={permissionMode}>
          <option value="">Default</option>
          <option value="default">Default (ask)</option>
          <option value="plan">Plan mode</option>
          <option value="full">Full auto</option>
        </select>
      </div>
    </div>

    </form>

    {#if showCwdMissing}
      <div class="conflict-warning">
        <div class="conflict-header">Directory not found</div>
        <div class="conflict-item">
          <span class="conflict-icon">&#x26A0;</span>
          <span><code>{cwd.trim()}</code> does not exist. Create it?</span>
        </div>
        <div class="conflict-actions">
          <button class="cancel-btn" on:click={cancelMissing}>Cancel</button>
          <button class="launch-btn" on:click={createDirAndLaunch}>Create & Launch</button>
        </div>
      </div>
    {:else if showConflictWarning && conflicts}
      <div class="conflict-warning">
        <div class="conflict-header">Conflicts detected</div>
        {#each conflicts.sameDirInstances as inst}
          <div class="conflict-item">
            <span class="conflict-icon">&#x26A0;</span>
            <span><strong>{inst.name}</strong> is already {inst.state} in this directory</span>
          </div>
        {/each}
        {#each conflicts.sameBranchInstances as inst}
          <div class="conflict-item">
            <span class="conflict-icon">&#x26A0;</span>
            <span><strong>{inst.name}</strong> is on the same branch <code>{inst.branch}</code> in {inst.cwd}</span>
          </div>
        {/each}

        {#if showCloneInput}
          <div class="clone-field">
            <label for="cloneDir">Clone to directory</label>
            <input id="cloneDir" type="text" bind:value={cloneDir} placeholder="~/Development/my-project-copy" />
          </div>
          <div class="conflict-actions">
            <button class="cancel-btn" on:click={cancelConflict}>Back</button>
            <button class="launch-btn" on:click={launchWithClone}>Clone & Launch</button>
          </div>
        {:else}
          <div class="conflict-actions">
            <button class="cancel-btn" on:click={cancelConflict}>Cancel</button>
            <button class="clone-btn" on:click={() => showCloneInput = true}>Clone & Launch</button>
            <button class="launch-btn" on:click={launchAnyway}>Launch Anyway</button>
          </div>
        {/if}
      </div>
    {:else}
      <div class="actions">
        <button class="cancel-btn" on:click={cancel}>Cancel</button>
        <button class="launch-btn" on:click={launch}>Launch (Ctrl+Enter)</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    width: 480px;
    max-width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
  }

  h2 {
    font-size: 16px;
    margin-bottom: 20px;
  }

  .field {
    margin-bottom: 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-row {
    display: flex;
    gap: 12px;
  }

  .field-row .field {
    flex: 1;
  }

  label {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 600;
  }

  input[type="text"], select {
    width: 100%;
  }

  .autocomplete-wrap {
    position: relative;
  }

  .input-with-browse {
    display: flex;
    gap: 4px;
  }

  .input-with-browse input {
    flex: 1;
  }

  .browse-btn {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-size: 14px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .browse-btn:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .browse-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 6px 6px;
    list-style: none;
    max-height: 120px;
    overflow-y: auto;
    z-index: 10;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .suggestions li {
    padding: 6px 10px;
    font-size: 13px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .suggestions li:hover,
  .suggestions li.selected {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .name-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-weight: 400;
    cursor: pointer;
    user-select: none;
  }

  .toggle-label input[type="checkbox"] {
    width: auto;
    accent-color: var(--accent);
  }

  .toggle-label span {
    font-size: 11px;
    color: var(--text-muted);
  }

  .auto-name-hint {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
    padding: 6px 0;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }

  .cancel-btn {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .cancel-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .launch-btn {
    background: var(--accent);
    color: #fff;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
  }

  .launch-btn:hover {
    background: var(--accent-hover);
  }

  .conflict-warning {
    background: rgba(255, 180, 50, 0.08);
    border: 1px solid rgba(255, 180, 50, 0.3);
    border-radius: 8px;
    padding: 14px;
    margin-top: 16px;
  }

  .conflict-header {
    font-size: 13px;
    font-weight: 600;
    color: #f0a030;
    margin-bottom: 8px;
  }

  .conflict-item {
    font-size: 12px;
    color: var(--text-secondary);
    padding: 4px 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .conflict-icon {
    color: #f0a030;
    flex-shrink: 0;
  }

  .conflict-item code {
    background: var(--bg-primary);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
  }

  .conflict-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  .clone-btn {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    color: #f0a030;
    border: 1px solid rgba(255, 180, 50, 0.4);
    background: transparent;
  }

  .clone-btn:hover {
    background: rgba(255, 180, 50, 0.1);
    border-color: #f0a030;
  }

  .clone-field {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .clone-field label {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 600;
  }
</style>
