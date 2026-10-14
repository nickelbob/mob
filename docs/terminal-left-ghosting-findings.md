# Terminal left-column "ghosting" — investigation findings

**Date:** 2026-06-25
**Reporter symptom:** "The leftmost two character columns in the sessions hang on
to old chars as text scrolls up or down." Later narrowed to: **happens when
scrolling with the mouse wheel.** Worked fine ~2 weeks prior.

## TL;DR

The ghosting is a **Claude Code CLI TUI rendering bug**, reproduced at the byte
level. It is **not** a bug in mob or in xterm.js. Every rendering layer faithfully
reproduces the exact (flawed) byte stream Claude emits. **The fix belongs in
Claude Code** — updating the Claude CLI may already resolve it. Nothing changed in
mob can correctly fix it without breaking Claude's in-TUI mouse features.

> **Update 2026-06-25 — see ["Recheck against Claude 2.1.191"](#update-2026-06-25--recheck-against-claude-21191) below.**
> The machine is already on the latest Claude (2.1.191), and an upstream change
> (2.1.150) reworked the exact trigger: the mouse wheel no longer scrolls the
> conversation, so the buggy wheel→repaint path that dirtied the gutter no longer
> fires. Strong evidence it's fixed/neutralized upstream; one real-mouse-wheel
> scroll in a *fresh* session is the only confirmation left.

## Symptom

- Stale characters remain in the leftmost ~1-2 columns (the "gutter"/indent) of
  lines while content scrolls.
- Example captured from the live buffer: lines that should read `  - Conflict`,
  `● Clean work`, `  ptd (merge…` instead rendered as `pt- Conflict`,
  `●tClean work`, `ptd (merge…` — a stale `pt`/`t`/`(` glyph stuck in columns
  0-2.

## How it was investigated

Instrumented the **live** running dashboard with Chrome DevTools (MCP), reading
xterm's actual parsed buffer (`buffer.active.getLine(y).translateToString()`),
hooking `terminal.write`, `onResize`, and `onScroll`, and dispatching synthetic
`WheelEvent`s over the terminal viewport.

### Key observations

1. **Renderer is irrelevant.** Confirmed WebGL renderer active (2 canvases,
   `domRowsChildren: 0`) — ghosting still happened. Also happened on the default
   DOM renderer. A renderer paint bug cannot survive in the *parsed buffer*, yet
   the buffer itself was corrupt → not a paint issue.

2. **At rest the buffer is clean.** `cols≈135, rows=50, buffer.length == rows`,
   left edges all correct. The corruption only appears after interaction.

3. **Claude runs in the alternate-screen buffer.** `buffer.length == rows` and
   `baseY == 0` ⇒ no scrollback; it's a fixed full-screen TUI that repaints in
   place (like vim/less). Mouse mode is on
   (`ESC[?1000h ESC[?1002h ESC[?1003h ESC[?1006h`).

4. **Wheel-scroll corrupts the parsed buffer.** After dispatching wheel events,
   the buffer's left edges showed shifted/stale fragments. The instrumentation
   recorded **no resize and no scroll events — only `write` events.** So the
   corruption arrives purely as written bytes (Claude's repaint), not from any
   mob-side resize/scroll manipulation.

5. **Byte-level proof.** The repaint sequence Claude sends for a line is, e.g.:

   ```
   ESC[2;1H ESC[K  ...  ESC[3;3H Ran 1 shell command
   ```

   - Some lines: `ESC[r;1H ESC[K` → clears the whole line (fine).
   - Other lines: `ESC[r;3H <text>` → cursor jumps straight to **column 3** and
     writes, **without clearing columns 1-2**, and with **no full-screen clear**
     (`ESC[2J` absent — `hasFullScreenClear: false`). Bullets are drawn as
     `ESC[r;1H ● ESC[1C <text>` — `ESC[1C` (cursor-forward) steps over the gap
     column **without erasing it**.
   - Result: when scrolling changes which content occupies a screen row, Claude's
     incremental diff leaves whatever was previously in columns 1-2 untouched →
     ghosting.

6. **Terminal-independent.** Reproduced identically on:
   - xterm **5.3.0** (original) and **6.0** (`@xterm/xterm@6.0`, after upgrade),
   - **DOM** and **WebGL** renderers,
   - mob's **server-side headless terminal + serialize** snapshot — switching
     away from and back to the instance (which re-renders from the server
     snapshot) did **not** clean it, because the headless terminal parsed the
     same corrupt bytes.

   Since client xterm (two versions), both renderers, and the independent
   server-side headless parser all reproduce it, the defect is in the **input
   byte stream from Claude**, not in any rendering code.

## Why it regressed "~2 weeks ago"

The latest mob commit is 2026-05-13; no mob change lines up with the regression.
The trigger was a **Claude Code CLI update** that changed its TUI rendering
(this same update also turned on mouse reporting, which separately broke
Ctrl+C copy — see below). mob's code was unchanged.

## What does NOT fix it (things tried this session)

- ❌ Switching to the **WebGL renderer** (`@xterm/addon-webgl`).
- ❌ Forcing a **full repaint on every write** (`terminal.refresh(0, rows-1)` /
  wrapping `write`).
- ❌ **Upgrading xterm.js** 5.3.0 → 6.0 (`@xterm/*` scoped packages).
- ❌ Re-syncing the client from the server-side scrollback snapshot (snapshot is
  equally corrupt).

These all fail for the same reason: they operate on rendering, but the corruption
is in Claude's emitted bytes.

## Recommended fix

1. **Update the Claude Code CLI** used inside the sessions (`claude update` or
   reinstall). The TUI repaint bug may already be fixed upstream.
2. If still present after updating, **report it to Claude Code**: during a
   mouse-wheel-driven scroll-repaint in the alternate screen, lines repositioned
   with `ESC[r;3H` (and bullets via `ESC[r;1H●ESC[1C`) do not clear gutter
   columns 1-2 and no `ESC[2J` is issued, leaving stale glyphs there.

### Possible mob-side mitigations (all imperfect — not implemented)

- **`CLAUDE_CODE_DISABLE_MOUSE=1` in the PTY env** *(recommended mitigation — found
  during the 2026-06-25 recheck)*. Officially-supported env var that tells Claude
  not to enable mouse tracking at all, so the wheel never produces a mouse report
  and never triggers the buggy repaint. One line in `pty-manager.ts` beside the
  existing `MOB_INSTANCE_ID` injection. This is the clean version of the two ideas
  below. Cost: disables Claude's in-TUI mouse clicks (permission prompts,
  `/model`, `/config` menus — mouse-click support was added in 2.1.187).
- **`CLAUDE_CODE_NO_FLICKER=1`** — opt-in alt-screen rendering (since 2.1.88,
  likely the default now). Doesn't target the gutter bug directly but is the
  modern rendering path; harmless to set.
- **Suppress mouse-wheel → Claude forwarding** so the wheel never triggers
  Claude's buggy repaint. Cost: breaks Claude's in-TUI mouse features (clicks,
  its own scroll). Fragile. (Superseded by `CLAUDE_CODE_DISABLE_MOUSE=1` above.)
- **Inject a refresh trigger** (e.g. Ctrl+L) after scroll to force Claude to do a
  clean full repaint. Cost: depends on Claude binding it to redraw; risk of
  inserting stray input.
- **Strip mouse-mode-enable sequences** from the PTY stream. Same downside as the
  suppress-forwarding idea. (Superseded by `CLAUDE_CODE_DISABLE_MOUSE=1`.)

None of the last three are clean; the correct fix is in Claude Code (and now
appears to be there — see the recheck below).

## Update 2026-06-25 — recheck against Claude 2.1.191

Revisited after the user noted Claude recently changed its TUI. Combined web
research + a live recheck of the running dashboard.

### What the research found

- **Already on the latest Claude.** `claude --version` reports **2.1.191** (top of
  the changelog). So the original doc's primary recommendation — "update the Claude
  CLI" — is already satisfied on this machine. The fix, if shipped, is present.
- **The trigger was reworked upstream.** Changelog **2.1.150**: the mouse wheel no
  longer scrolls the conversation viewport — it now sends arrow keys, and PgUp/PgDn
  scrolls instead (GitHub issue #65833). The ghosting was caused *specifically* by
  wheel → Claude's incremental alt-screen conversation repaint that skipped clearing
  gutter columns 1-2. With the wheel no longer driving that repaint, the buggy path
  should no longer fire.
- **Targeted corruption fixes also landed:** 2.1.187 "Fixed fullscreen TUI
  corruption (statusline mid-screen, duplicated spinner rows, merged text)"; 2.1.144
  "Fixed progressive terminal display corruption … in very long sessions" and
  missed-resize garble now self-heals.
- **Not the Windows-console auto-disable.** 2.1.172 "Disable mouse tracking on
  Windows consoles that don't fully support it" does **not** auto-fire for mob —
  mob renders in xterm.js, which *does* support mouse, so Claude keeps mouse mode on
  unless told otherwise.

### What the live recheck could and couldn't show

- Instrumented the running dashboard (Chrome DevTools). The buffer that **still**
  shows the exact ghosting signature (`●tBuild clean.`, `ptRan 1 shell`,
  `pt- Conflicts`, `  ptd (merge`) belongs to a **long-lived session whose `claude`
  process predates the update** — a running PTY keeps its old binary even after
  `claude --version` on PATH reports 2.1.191.
- That frozen buffer **could not be driven to repaint**: synthetic `WheelEvent`s
  don't make xterm emit mouse reports, and injecting input via xterm's
  `coreService.triggerDataEvent` (wheel reports, Ctrl+L, a literal `x`) did **not**
  round-trip to the PTY (the cached `__mobTerm` handle from the earlier session is
  no longer wired to a live input path). So the residue is **not** evidence about
  2.1.191's live behavior, and a clean on-demand repro wasn't achievable via browser
  automation.

### Verdict

**Very likely fixed / neutralized upstream.** We're already on the version that
reworked the wheel trigger and fixed multiple TUI-corruption modes. The only thing
the recheck couldn't do is the final empirical confirmation, because it needs a
genuine mouse wheel (not a synthesizable event) in a **fresh** 2.1.191 process.

**To confirm (≈30s):** launch a brand-new session in mob, get a screenful of
bulleted output, then scroll up/down with a **real mouse wheel** and watch
columns 0-2. Expected on 2.1.191: no ghosting — the wheel now emits arrow keys
rather than triggering Claude's conversation repaint.

**If it ever recurs**, the clean fix is `CLAUDE_CODE_DISABLE_MOUSE=1` in the PTY
env (see the mitigations list above) — guaranteed to remove the trigger, at the
cost of in-TUI mouse clicks.

## State of mob-side changes made while chasing this (uncommitted)

In `src/client/components/TerminalPanel.svelte` plus package files:

1. **Copy-on-Ctrl+C fix** — a *separate, real mob bug* that WAS fixed: copying
   selection now works regardless of textarea focus / insecure context
   (focus-independent capture-phase handler + `execCommand` fallback). **Keep.**
2. **WebGL renderer addon** — loaded after `terminal.open()` with graceful
   fallback. Did not fix ghosting; harmless, slightly faster.
3. **xterm 5.3.0 → 6.0 upgrade** — `xterm`/`xterm-addon-*`/`xterm-headless`
   migrated to the `@xterm/*` scope. Did not fix ghosting; healthy upgrade on its
   own. Touches: `TerminalPanel.svelte`, `src/client/main.ts` (CSS import),
   `src/server/scrollback-buffer.ts` (headless + serialize imports), `package.json`.

All verified building/typechecking; scrollback tests pass. Nothing committed yet.

## Related

- The Ctrl+C copy regression investigated the same day shares a root cause
  ingredient (Claude's TUI enabling **mouse mode**), but that one was a genuine
  mob bug and is fixed.
