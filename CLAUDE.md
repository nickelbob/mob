# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Mob is a local web dashboard that coordinates multiple Claude Code CLI sessions: a shared WS protocol (`src/shared/`), a Node.js backend (`src/server/`), and a Svelte 5 client (`src/client/`).

## Data Flow

**Instance launch:** Client WS `launch` → InstanceManager creates ID + spawns PTY → emits `instance:update` → WS broadcasts to all clients → client auto-subscribes to terminal output.

**Terminal I/O:** xterm `onData` → WS `terminal:input` → PtyManager writes to PTY stdin → PTY emits data → WS `terminal:output` → only subscribed clients receive it.

**External instance discovery:** Hook script writes JSON to `~/.mob/instances/{id}.json` and/or POSTs to `/api/hook` → DiscoveryService or Express route → InstanceManager merges into instance map → broadcasts update.

## Key Design Details

- Client components use Svelte 4 legacy syntax (`on:click`, `export let`, `$:`, `$store`), not Svelte 5 runes. The `compatibility.componentApi: 4` flag is set in `svelte.config.js`.
- WebSocket path is `/mob-ws` (not `/ws`) to avoid conflicting with Vite's HMR WebSocket in dev.
- In dev, Vite on :4041 proxies `/api` to :4040 but WS proxy is unreliable — the client detects dev mode (port 4041) and connects WS directly to :4040.
- PTY spawns a shell first (not `claude` directly) so the user's PATH/auth loads and they can Ctrl+C back to a shell.
- `~` paths from the frontend are expanded server-side via `os.homedir()` in pty-manager.
- Instances with `autoName: true` get renamed when the first `subtask` arrives via hook update.
- Stale detection: instances with no update for 30s get marked `stale` (checked every 10s).
