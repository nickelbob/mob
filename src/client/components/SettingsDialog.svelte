<script lang="ts">
  import { showSettingsDialog, settings, sidebarCollapsed } from '../lib/stores.js';
  import { saveSettings } from '../lib/settings-client.js';
  import { eventToShortcut, formatShortcut } from '../lib/shortcuts.js';
  import { DEFAULT_SETTINGS } from '../../shared/settings.js';
  import type { Settings } from '../../shared/settings.js';

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  let activeTab = 'shortcuts';
  let localSettings: Settings = structuredClone($settings);
  // Ensure jira section exists (handles settings loaded before jira feature)
  if (!localSettings.jira) {
    localSettings.jira = { baseUrl: '', email: '', apiToken: '' };
  }
  let dirty = false;

  // Shortcut capture state
  let capturingKey: string | null = null;

  const shortcutLabels: Record<string, string> = {
    launchDialog: 'Launch Dialog',
    toggleSidebar: 'Toggle Sidebar',
    cycleInstanceDown: 'Next Instance',
    cycleInstanceUp: 'Previous Instance',
    collapseGroup: 'Collapse Group',
    expandGroup: 'Expand Group',
    jumpToInstance1: 'Jump to Instance 1',
    jumpToInstance2: 'Jump to Instance 2',
    jumpToInstance3: 'Jump to Instance 3',
    jumpToInstance4: 'Jump to Instance 4',
    jumpToInstance5: 'Jump to Instance 5',
    jumpToInstance6: 'Jump to Instance 6',
    jumpToInstance7: 'Jump to Instance 7',
    jumpToInstance8: 'Jump to Instance 8',
    jumpToInstance9: 'Jump to Instance 9',
    resumeInstance: 'Resume Selected Instance',
    killInstance: 'Kill Selected Instance',
    dismissInstance: 'Dismiss Selected Instance',
    openSettings: 'Open Settings',
  };

  function startCapture(key: string) {
    capturingKey = key;
  }

  function handleCaptureKeydown(e: KeyboardEvent) {
    if (!capturingKey) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      capturingKey = null;
      return;
    }

    const shortcut = eventToShortcut(e, isMac);
    if (!shortcut) return; // bare modifier

    // Check for conflicts
    const conflict = Object.entries(localSettings.shortcuts).find(
      ([k, v]) => k !== capturingKey && v === shortcut
    );
    if (conflict) {
      alert(`"${shortcut}" is already used by "${shortcutLabels[conflict[0]] || conflict[0]}"`);
      return;
    }

    (localSettings.shortcuts as any)[capturingKey] = shortcut;
    localSettings = localSettings; // trigger reactivity
    dirty = true;
    capturingKey = null;
  }

  function setTab(tab: string) {
    activeTab = tab;
  }

  async function save() {
    try {
      const updated = await saveSettings(localSettings);
      settings.set(updated);
      sidebarCollapsed.set(updated.general.sidebarCollapsed);
      dirty = false;
    } catch (err: any) {
      alert('Failed to save settings: ' + (err?.message || 'Unknown error'));
    }
  }

  async function close() {
    if (dirty) {
      await save();
    }
    showSettingsDialog.set(false);
  }

  async function resetToDefaults() {
    if (!confirm('Reset all settings to defaults?')) return;
    localSettings = structuredClone(DEFAULT_SETTINGS);
    dirty = true;
    await save();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (capturingKey) {
      handleCaptureKeydown(e);
      return;
    }
    if (e.key === 'Escape') close();
  }

  function markDirty() {
    dirty = true;
  }

  const tabs = [
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'launch', label: 'Launch Defaults' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'general', label: 'General' },
    { id: 'jira', label: 'JIRA' },
  ];
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
<div class="overlay" on:click={close} role="dialog" tabindex="-1">
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div class="dialog" on:click|stopPropagation role="document">
    <h2>Settings</h2>

    <div class="tabs">
      {#each tabs as tab}
        <button
          class="tab"
          class:active={activeTab === tab.id}
          on:click={() => setTab(tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    <div class="tab-content">
      {#if activeTab === 'shortcuts'}
        <div class="shortcuts-table">
          {#each Object.entries(shortcutLabels) as [key, label]}
            <div class="shortcut-row">
              <span class="shortcut-label">{label}</span>
              <span class="shortcut-binding">
                {#if capturingKey === key}
                  <span class="capturing">Press a key combo...</span>
                {:else}
                  <kbd>{formatShortcut(localSettings.shortcuts[key], isMac)}</kbd>
                {/if}
              </span>
              <button class="change-btn" on:click={() => startCapture(key)}>
                {capturingKey === key ? 'Cancel' : 'Change'}
              </button>
            </div>
          {/each}
        </div>

      {:else if activeTab === 'launch'}
        <div class="field">
          <label for="settings-cwd">Default Working Directory</label>
          <input id="settings-cwd" type="text" bind:value={localSettings.launch.cwd} on:input={markDirty} placeholder="(empty = no prefill)" />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="settings-model">Default Model</label>
            <select id="settings-model" bind:value={localSettings.launch.model} on:change={markDirty}>
              <option value="">System Default</option>
              <option value="claude-opus-4-6">Opus 4.6</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6</option>
              <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
            </select>
          </div>
          <div class="field">
            <label for="settings-perm">Default Permission Mode</label>
            <select id="settings-perm" bind:value={localSettings.launch.permissionMode} on:change={markDirty}>
              <option value="">System Default</option>
              <option value="default">Default (ask)</option>
              <option value="plan">Plan mode</option>
              <option value="full">Full auto</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label class="toggle-label">
            <input type="checkbox" bind:checked={localSettings.launch.autoName} on:change={markDirty} />
            <span>Auto-name instances (let Claude decide)</span>
          </label>
        </div>

      {:else if activeTab === 'terminal'}
        <div class="field">
          <label for="settings-fontsize">Font Size ({localSettings.terminal.fontSize}px)</label>
          <input id="settings-fontsize" type="range" min="8" max="24" bind:value={localSettings.terminal.fontSize} on:input={markDirty} />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="settings-cursor">Cursor Style</label>
            <select id="settings-cursor" bind:value={localSettings.terminal.cursorStyle} on:change={markDirty}>
              <option value="block">Block</option>
              <option value="underline">Underline</option>
              <option value="bar">Bar</option>
            </select>
          </div>
          <div class="field">
            <label for="settings-scrollback">Scrollback Lines</label>
            <input id="settings-scrollback" type="number" min="100" max="100000" step="1000" bind:value={localSettings.terminal.scrollbackLines} on:input={markDirty} />
          </div>
        </div>

      {:else if activeTab === 'general'}
        <div class="field">
          <label class="toggle-label">
            <input type="checkbox" bind:checked={localSettings.general.sidebarCollapsed} on:change={markDirty} />
            <span>Start with sidebar collapsed</span>
          </label>
        </div>
        <div class="field">
          <label class="toggle-label">
            <input type="checkbox" bind:checked={localSettings.general.notifications} on:change={markDirty} />
            <span>Browser notifications for waiting instances</span>
          </label>
        </div>
        <div class="field">
          <label class="toggle-label">
            <input type="checkbox" bind:checked={localSettings.general.notificationSound} on:change={markDirty} />
            <span>Play sound when instance needs input</span>
          </label>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="settings-maxcache">Max Cached Terminals</label>
            <input id="settings-maxcache" type="number" min="1" max="100" bind:value={localSettings.general.maxCachedTerminals} on:input={markDirty} />
          </div>
        </div>
      {:else if activeTab === 'jira'}
        <div class="field">
          <label for="settings-jira-url">JIRA Base URL</label>
          <input id="settings-jira-url" type="text" bind:value={localSettings.jira.baseUrl} on:input={markDirty} placeholder="https://mycompany.atlassian.net" />
        </div>
        <div class="field">
          <label for="settings-jira-email">JIRA Email</label>
          <input id="settings-jira-email" type="text" bind:value={localSettings.jira.email} on:input={markDirty} placeholder="user@company.com" />
        </div>
        <div class="field">
          <label for="settings-jira-token">JIRA API Token</label>
          <input id="settings-jira-token" type="password" bind:value={localSettings.jira.apiToken} on:input={markDirty} placeholder={localSettings.jira.apiToken === '••••' ? 'Configured' : 'Paste API token'} />
        </div>
      {/if}
    </div>

    <div class="actions">
      <button class="reset-btn" on:click={resetToDefaults}>Reset to Defaults</button>
      <button class="close-btn" on:click={close}>Close</button>
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
    width: 560px;
    max-width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
  }

  h2 {
    font-size: 16px;
    margin-bottom: 16px;
  }

  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }

  .tab {
    padding: 8px 14px;
    font-size: 13px;
    background: transparent;
    color: var(--text-secondary);
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s;
  }

  .tab:hover {
    color: var(--text-primary);
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab-content {
    min-height: 200px;
  }

  .shortcuts-table {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }

  .shortcut-label {
    flex: 1;
    font-size: 13px;
    color: var(--text-primary);
  }

  .shortcut-binding {
    min-width: 120px;
    text-align: center;
  }

  .shortcut-binding kbd {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 8px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .capturing {
    font-size: 12px;
    color: var(--accent);
    font-style: italic;
  }

  .change-btn {
    padding: 3px 10px;
    font-size: 12px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .change-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
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

  input[type="text"],
  input[type="number"],
  input[type="password"],
  select {
    width: 100%;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--accent);
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 400;
    cursor: pointer;
    user-select: none;
  }

  .toggle-label input[type="checkbox"] {
    width: auto;
    accent-color: var(--accent);
  }

  .toggle-label span {
    font-size: 13px;
    color: var(--text-primary);
  }

  .actions {
    display: flex;
    justify-content: space-between;
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .reset-btn {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--red);
    border: 1px solid var(--border);
    background: transparent;
    cursor: pointer;
  }

  .reset-btn:hover {
    border-color: var(--red);
  }

  .close-btn {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }

  .close-btn:hover {
    background: var(--accent-hover);
  }
</style>
