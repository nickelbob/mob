<script lang="ts">
  import type { InstanceState } from '../lib/types.js';
  export let state: InstanceState;

  const labels: Record<InstanceState, string> = {
    launching: 'Starting',
    running: 'Running',
    idle: 'Idle',
    waiting: 'Needs Input',
    stopped: 'Stopped',
  };
</script>

<span class="badge {state}">{labels[state] || state}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .badge::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .running { color: #ffffff; background: rgba(63, 185, 80, 0.35); }
  .running::before {
    width: 8px;
    height: 8px;
    border: 1.5px solid var(--green);
    border-top-color: transparent;
    border-radius: 50%;
    background: transparent;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .idle { color: #ffffff; background: rgba(88, 166, 255, 0.35); }
  .idle::before { background: var(--accent); }

  .waiting { color: #ffffff; background: rgba(210, 153, 34, 0.45); }
  .waiting::before {
    background: var(--yellow);
    animation: pulse 1s ease-in-out infinite;
  }

  .stopped { color: #e6edf3; background: rgba(139, 148, 158, 0.3); }
  .stopped::before { background: var(--text-muted); }

  .launching { color: #ffffff; background: rgba(210, 153, 34, 0.35); }
  .launching::before {
    background: var(--yellow);
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
</style>
