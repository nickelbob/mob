# Plan: persist externally-discovered sessions so they survive restarts

## Problem
`sessionStore.save()` is gated on `managedIds.has(id)` at every call site, so only
mob-spawned (managed) sessions are persisted to `~/.mob/sessions/`. Externally-started
Claude sessions — discovered only via the hook channel — live solely as ephemeral
`~/.mob/instances/{id}.json` snapshots and are never promoted to the resumable store.
On a worker restart they vanish (this is what happened on 2026-07-14 13:36: store had 1
managed entry, the other 5 active sessions were external and were lost).

## Goal
Persist external sessions that carry a `claudeSessionId` into the session store so they
return as **resumable** cards after a restart.

## Key design decision
Persisted external sessions must **not** auto-resume on restart and must **not** be marked
`managed`:
- The external terminal is independent of mob's lifecycle. If it's still alive across a
  restart, auto-spawning `claude --resume <id>` creates a second process on the same
  conversation → fork/conflict.
- So persist as historical/resumable (`autoResume` off). If the external terminal is still
  alive, its own hooks reconcile the card back to *live external* within seconds. If dead,
  the user clicks **Resume** (spawns a fresh mob-managed `--resume` PTY).

"Resumable" is therefore decoupled from "managed": a card is resumable when
`state === 'stopped' && claudeSessionId` is present, regardless of origin.

## Server changes (`src/server/`)

1. `session-store.ts` — persist origin
   - Add `managed?: boolean` to `SessionData`.
   - `save()`: write `instance.managed`.
   - `loadAll()`: restore `managed: data.managed ?? true` (defaults true → existing files,
     all previously managed, behave unchanged). Keep `historical: true`, `state: 'stopped'`.

2. `instance-manager.ts` — save external sessions (the actual gap)
   - `handleHookUpdate` (~L787): change save gate from
     `managedIds.has(id) && claudeSessionId` to
     `claudeSessionId && (managedIds.has(id) || isManaged === false)` — persist whenever we
     have a resumable session id; record real origin via `info.managed`.
   - Clear stale historical state when a live hook arrives (merge path ~L740-758):
     `info.historical = false` and `info.stoppedAt = undefined` once state goes non-stopped.

3. `instance-manager.ts` — don't fake-manage reloaded externals
   - `loadPreviousSessions` (~L147): guard `this.managedIds.add(info.id)` behind
     `if (info.managed)`. Keeps externals out of `managedIds` so the "straggler hook for
     stopped instance" guard (L695-703) doesn't swallow their live hooks and the stale-check
     PTY-dead→stopped sweep (L850-858) doesn't touch them. Adopt/auto-resume branches are
     already keyed on live PTY / `autoResume`, so externals fall through to historical card.

4. `instance-manager.ts` — allow resuming externals
   - `resume()` (L508): change `if (!old || !old.managed) return null;` to
     `if (!old || (!old.managed && !old.claudeSessionId)) return null;`. Resume already builds
     a new managed instance and uses `findProjectDirForSession` for cwd (verified end-to-end
     during the 2026-07-14 manual restore).

## Client changes (`src/client/`)
Swap resume gating from `managed` to resumable (`state === 'stopped' && claudeSessionId`):
- `InstanceCard.svelte:135`
- `InstanceList.svelte:6` (`resumableInstances`)
- `App.svelte:73` / `:89` (resume shortcut)
- `TerminalPanel.svelte` unchanged: live terminal I/O still requires a managed PTY; an
  un-resumed external card stays read-only until resumed.

## Bounds & compatibility
- Self-pruning: `loadAll()` already drops entries older than `SESSION_MAX_AGE_MS` (7 days).
- Backward compatible: `managed ?? true`.
- Write volume: external hooks fire per tool-use; atomic write+rename each, same as managed
  today. Debounce is a possible later optimization, not needed now.

## Tests
- `session-store` round-trip: `managed:false` → `loadAll` returns `managed:false`,
  `historical:true`; omitted → defaults `true`.
- Manager: reloaded `managed:false` stopped session + incoming live hook → card goes live
  external (not blocked by straggler guard, not marked stopped by stale-check).
- Manual E2E: external `claude` session visible in mob → bounce worker → returns as resumable
  card → Resume → conversation loads.

## Related (separate) — ROOT CAUSE FOUND
- Discovery startup re-seed was dead: `readStatusFile` does bare
  `JSON.parse(fs.readFileSync(fp,'utf-8'))`. The Windows hook `mob-status.ps1:133` writes files
  with `Out-File -Encoding UTF8`, which in **Windows PowerShell 5.1 emits a UTF-8 BOM**. All 148
  `instances/*.json` carry a BOM; bare `JSON.parse('﻿{...}')` throws → `readStatusFile`
  returns null → `DiscoveryService` never emits → the entire file-watch seed/fallback channel is
  dead. Live operation only survives via the parallel `/api/hook` POST (express parses BOM-free).
  Proven: 148/148 files have BOM, 148/148 throw bare-parse, 148/148 parse OK after BOM strip;
  raw chokidar (node and tsx) fires 148 adds, but `DiscoveryService` fires 0 updates.
  Fix (two parts):
    1. Server (robust): strip leading BOM in `status-reader.ts` before parse
       (`raw.replace(/^﻿/, '')`). Retroactively un-breaks all existing files + any producer.
    2. Hook (source): `mob-status.ps1` write BOM-less UTF-8, e.g.
       `[System.IO.File]::WriteAllText($TmpFile, $Json, (New-Object System.Text.UTF8Encoding $false))`.
  (The `.sh` writer uses `echo > file` — already BOM-free.)
- `~/.mob/instances/` has no pruning (files back to March).
