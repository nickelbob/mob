<script lang="ts">
  import { onDestroy } from 'svelte';
  import { showLaunchDialog, wsClient, settings } from '../lib/stores.js';
  import { get } from 'svelte/store';

  const launchDefaults = get(settings).launch;
  let name = '';
  let autoName = launchDefaults.autoName;
  let cwd = launchDefaults.cwd;
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
      showSuggestions = false;
    }
  }

  function launch() {
    if (!cwd.trim()) {
      alert('Working directory is required');
      return;
    }
    wsClient.send({
      type: 'launch',
      payload: {
        name: autoName ? '' : (name.trim() || `Instance ${Date.now().toString(36)}`),
        autoName,
        cwd: cwd.trim(),
        model: model || undefined,
        permissionMode: permissionMode || undefined,
      },
    });
    showLaunchDialog.set(false);
    reset();
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
    model = defaults.model;
    permissionMode = defaults.permissionMode;
    suggestions = [];
    showSuggestions = false;
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

  function autofocus(node: HTMLElement) {
    node.focus();
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
  <div class="dialog" on:click|stopPropagation role="document">
    <h2>Launch Claude Instance</h2>

    <div class="field">
      <label for="cwd">Working Directory *</label>
      <div class="autocomplete-wrap">
        <div class="input-with-browse">
          <input
            id="cwd"
            type="text"
            bind:value={cwd}
            on:input={onCwdInput}
            on:keydown={handleCwdKeydown}
            on:focus={() => { if (suggestions.length) showSuggestions = true; }}
            on:blur={() => { setTimeout(() => showSuggestions = false, 200); }}
            placeholder="~/Development/my-project"
            autocomplete="off"
            use:autofocus
          />
          {#if canBrowse}
            <button class="browse-btn" on:click={browseDir} disabled={browsing} title="Browse for folder">
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

    <div class="actions">
      <button class="cancel-btn" on:click={cancel}>Cancel</button>
      <button class="launch-btn" on:click={launch}>Launch (Ctrl+Enter)</button>
    </div>
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
    max-height: 200px;
    overflow-y: auto;
    z-index: 10;
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
</style>
