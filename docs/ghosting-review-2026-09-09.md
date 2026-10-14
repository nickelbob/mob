# Terminal ghosting review — 2026-09-09

Read-only review of the terminal output path (PTY → supervisor → ws-server → xterm), the resubscribe/replay path and the resize path, plus byte-level replay of live scrollback logs from `~/.mob/scrollback/`. `npm test`: 128/128 pass. `npm run lint`: clean.

## TL;DR

The ghosting is a mob bug: `convertEol: true` in `src/client/components/TerminalPanel.svelte:95`. The PTY stream on Windows (ConPTY's re-render of Claude's screen) uses a bare `\n` to mean "cursor down one row, same column". `convertEol` rewrites it to `\r\n`, so the text that should start at column 3 lands at column 1. Every later diff frame then paints from column 3 over the shifted row, leaving the first two characters of the shifted line in the gutter (`Tw|o things`, `Co|nfidence`, `(b|ackground`) and interleaving stale characters across the rest of the row. Delete the option and the corruption disappears in replay.

The June finding ("Claude's TUI never clears cols 1-2, not our bug") was a misreading of the same symptom: the `ESC[r;3H` diffs it saw are ConPTY's correct output; the gutter garbage was already there because of the LF conversion.

## Root cause 1 — `convertEol: true` (confidence: high, reproduced)

**Where:** `src/client/components/TerminalPanel.svelte:95` (`convertEol: true` in the `new Terminal({...})` options). Present since the initial commit (3f70d5a, 2026-03-25); the trigger arrived upstream when Claude switched to its in-place alt-screen renderer and ConPTY started emitting same-column LF moves for it.

**Mechanism.** ConPTY (this machine uses it: `@lydell/node-pty` on win32 always loads the `conpty` native module, `node_modules/@lydell/node-pty-win32-x64/lib/windowsPtyAgent.js:36-44`) does not forward Claude's bytes; it diffs its own screen buffer and emits the cheapest cursor moves. Live logs contain sequences like:

```
ESC[23;3H ESC[K ESC[38;2;177;185;249m ESC[1m \n trackWebVitals ESC[m ...
ESC[6;3H  ESC[K ESC[38;2;153;153;153m \n Ran ESC[1m 3 ESC[22m shell commands
ESC[33;3H ESC[K \n Two th ESC[1C ngs I did ESC[1C not ESC[1C do: no commit,
```

Cursor to (r,3), erase to EOL, then `\n` = "(r+1, 3)", then the text. xterm with `convertEol` turns the `\n` into CR+LF: text goes to (r+1, 1). The row is now 2 columns left of where ConPTY believes it is. All later frames are cell diffs (in a 512 KB window of one session: 5,987 CUP, 11,102 `ESC[nC` skips, 0 `ESC[2J`, 38 `ESC[K`) that skip cells ConPTY considers unchanged, so the shifted row is never repaired: cols 1-2 keep the first two letters, and every skipped cell keeps a character from the shifted text (`fixes thz 262 leaked`, `Array.isgrray`, `no commit,oandhthii`). Bare LFs per log window: 57 (`mob-07d75ef1`), 15 (`mob-a9e35ef4`), 4, 2, 2.

**Evidence.**

1. `Screenshot 2026-06-25 115706.png` shows exactly this signature: `(b`, `●oBoth`, `Co|blue-green`, `Tw`, `Wa`, `"T-` — heads of lines, plus interleaved garbage mid-row (`theseleuve n  transcript`).
2. Headless xterm 5.3 (same parser as the client) replaying `~/.mob/scrollback/mob-a9e35ef4-….log` from a clean screen at the PTY's real size (172x52):
   - `convertEol: true` → 16 corrupt rows (`|tr|what lets whenStable() resolve, which fixes thz 262 leaked`, `|Tw|o thingshI did not do: no commit,oandhthii is sitting tn E`, ...).
   - `convertEol: false` → 0 corrupt rows. Same for `mob-07d75ef1` (2 → 0).
   No resize, no client, no mob write path involved; the bytes plus that one option are sufficient.
3. An independent emulator (Python `pyte`, LF = move down only) renders the same bytes cleanly: rows 20-39 correct, gutters blank.
4. ConPTY is the renderer: a throwaway PTY (own process, not the mob server) whose child wrote `ESC[2;3Hindent` / `● ESC[1C bullet` came back re-serialized by conhost (`\r\n`-sequenced full lines), with Claude-style `ESC[?2026h/l` passed through *ahead* of conhost's own `ESC[?25l … ESC[?25h` frame — the exact ordering seen in the live logs. The same harness shows ConPTY does a full-viewport repaint (every row, `ESC[K` per row) on every real resize, which is why resize races (below) self-heal but LF corruption does not.

**Why Alt+Up/Alt+Down "heals".** `attachTerminal` (TerminalPanel.svelte:234-347) sends `terminal:unsubscribe`/`subscribe`; on `terminal:scrollback` the client does `terminal.clear()` and replays the raw 512 KB tail (TerminalPanel.svelte:360-369, server: ws-server.ts:315-322 → scrollback-buffer.ts:416-427). The replay rebuilds the screen from only the cells touched inside the window, so corruption caused by LFs that have scrolled out of the window is gone. Corruption from LFs still inside the window is reproduced (the `mob-a9e35ef4` replay above is what the user would see after a switch), which is why the heal is partial/probabilistic. The June note that "resubscribe did not clean it" is the same effect with a different window.

**Fix.** Remove `convertEol: true` (default is `false`). On Unix it is redundant anyway: libuv raw mode keeps `ONLCR`, so the kernel already emits `\r\n`; on Windows it is actively destructive. No other change is needed for this symptom.

**Verify.**
- Replay: `node scratchpad/replay.cjs ~/.mob/scrollback/<id>.log 52 clean convert` vs `… noconvert` (script in this session's scratchpad; it prints rows whose gutter holds text).
- Live: after the change, stream a long answer with bullets and indented continuation lines; cols 1-2 stay clean. Cheap instrumentation if wanted: count `(?<!\r)\n` in `terminal:output` payloads on the client — each one is a shift with the option on.

## Root cause 2 — terminal container height flips 49↔52 rows every ~minute (confidence: medium; it is a real resize storm, its layout source is unidentified)

`~/.mob/server.log` shows the single client (#2) sending `terminal:resize {cols:172, rows:49}` and `{rows:52}` alternately — 30 vs 29 of the last 60 resizes — with the instance in `running` state throughout (e.g. 16:11:15 → 49, 16:15:34 → 52, 16:18:23 → 49, 16:18:29 → 52). One log line per flip means it comes from the `ResizeObserver` (TerminalPanel.svelte:373-389), not a window resize (that path would log twice: `resizeHandler` at :397-408 plus the observer). Nothing in the code explains a ~3-row (≈50 px) in-flow element toggling while `state === 'running'`: the state banners (:493-505, ~28 px) need `waiting`/`launching`/`stopped`, `.last-prompt` is absolute (:553-568), `.update-banner` in App.svelte only changes on snapshot/`update:check`. It needs live instrumentation (log `terminalEl.getBoundingClientRect().height` and `terminal-panel` children in the observer callback).

Why it matters: every shrink is a race. The client resizes xterm first, then tells the PTY; frames already in flight were rendered for 52 rows, so CUP to rows 50-52 clamps to row 49 and any `\r\n` there scrolls the whole alt screen. ConPTY's full repaint after the resize repairs it (verified in the harness), so this shows as a flash of shifted content rather than persistent ghosts, but with LF corruption present it also reshuffles which ghosts are visible, and each flip makes Claude re-layout twice. Fix: find and pin the toggling element, and render state banners as overlays (absolute, like `.last-prompt`) so panel chrome never changes the terminal's row count.

## Hypotheses from the brief

| # | Hypothesis | Verdict |
|---|---|---|
| 1 | Chunk ordering/duplication | One real race: `terminal:subscribe` (ws-server.ts:300-323) sends the scrollback while a ≤16 ms batch for the same instance is still pending (ws-server.ts:116-165); the batch then flushes to the new subscriber → duplicate chunk. Idempotent for absolute-positioned diffs, not for `\r\n`-at-bottom frames. Not the streaming ghost, but a real defect. No reordering found: client handler is synchronous (TerminalPanel.svelte:350-370), `currentSubscription` flips atomically inside `attachTerminal`. |
| 2 | Byte splitting / transformation | No splitting: node-pty delivers decoded strings, the supervisor pipe is JSON lines, ws-server only concatenates. **The only transformation is `convertEol`, and it is the bug.** `stripAnsi` (terminal-state-detector.ts:6) only feeds state detection, never the client. |
| 3 | Resize races | Real and frequent (root cause 2) but self-healing on ConPTY. Client, headless (none exists today), and PTY sizes are otherwise in lockstep. |
| 4 | Server headless drift | Not applicable: there is no server-side headless terminal; `scrollback-buffer.ts` is a raw 512 KB chunk ring. The June experiment with headless+serialize is not in the tree. |
| 5 | `clear()` vs queued writes | No queue race (single synchronous handler). But `Terminal.clear()` (node_modules/xterm/src/browser/Terminal.ts:1204-1223) copies the *cursor line* to row 1 and is a no-op when the cursor is on row 1. In the alt screen the cursor line is Claude's `❯ ` input row, so after every switch/reconnect row 1 cols 1-2 hold `❯ ` until repainted. Minor, but it is a 2-column top-left ghost of mob's own making. Use `terminal.write('\x1b[H\x1b[2J')` (clears the alt buffer without resetting modes) before the replay instead. |
| 6 | Renderer / ConPTY / Windows options | ConPTY in use; DOM renderer; no `windowsPty`/`windowsMode` (only affects normal-buffer reflow, irrelevant in the alt screen). ConPTY's `ESC[8;rows;colst` is ignored (windowOptions off). xterm 5.3 uses Unicode 6 widths, conhost uses modern ones: emoji such as ✅/⏺ are 1 cell in xterm, 2 in conhost → 1-column shifts after an emoji within a line (secondary, add `xterm-addon-unicode11`). |
| 7 | Multiple xterm instances | One per instance, cached (TerminalPanel.svelte:25, 61-104). Detached ones receive no writes (handler gated on `currentSubscription`) and are not fitted. OK. |
| 8 | Keyboard/mouse handlers | No double-send. Mouse replay (TerminalPanel.svelte:140-232) only forwards clicks. |
| 9 | Session-store / discovery re-keying | Instances are keyed by hook `id`; no re-keying or merge that could route output to the wrong terminal. OK. |

## Other findings (by severity)

1. **ws-server.ts:300-323** — subscribe/flush duplicate race (above). Fix: in `terminal:subscribe`, before `subs.add(ws)`, clear the batch timer and `flushOutputBuffer(instanceId)` to the existing subscribers, then send the scrollback.
2. **src/client/lib/ws-client.ts:44-56** — all handlers run inside one `try`; if the stores handler throws for a message (e.g. a notification API error in `checkWaitingNotification`), the TerminalPanel handler is skipped and that output chunk is lost for good. Fix: try/catch per handler.
3. **src/server/terminal-state-detector.ts:6** — `ANSI_RE` terminates OSC only on BEL; Claude's OSC 8 hyperlinks end with `ESC \` (seen in live logs), so the regex swallows everything up to the next BEL, which can eat "esc to interrupt" / mode-footer text and misclassify state. Fix: `\][^\x07\x1b]*(?:\x07|\x1b\\)`.
4. **ws-server.ts:295-298 + instance-manager.ts:611-626** — `dismiss` is accepted for any state and never kills the PTY; dismissing a live managed instance leaks a running Claude the stale-check no longer sees. Fix: `if (this.ptyManager.has(id)) this.ptyManager.kill(id)` in `dismiss`.
5. **ws-server.ts:336-342** — any connected client's `terminal:resize` resizes the PTY; a second tab with different dimensions puts the first tab's xterm out of step with the PTY (CUP clamping, wraps). Fix: track the active viewer per instance (last subscriber wins) and ignore resizes from others, or size the PTY to the smallest subscriber.
6. **TerminalPanel.svelte:360-369, 476-487** — replay is a raw 512 KB tail starting at an arbitrary chunk boundary: SGR/cursor state before the window is unknown and untouched cells stay blank until ConPTY repaints them. With root cause 1 fixed this is cosmetic, but the robust path is a server-side headless xterm (`convertEol: false`, resized in lockstep from `terminal:resize`) with `xterm-addon-serialize` snapshots, as tried in June; the June headless "reproduced the ghost" because the same bytes carry the same LFs and it presumably had the same option.
7. **TerminalPanel.svelte:412-421** — `onDestroy` disposes neither the cached terminals nor `inputDisposable`; every Vite HMR remount leaks xterm instances and DOM. Fix: dispose the cache in `onDestroy`.
8. **TerminalPanel.svelte:380-385, 401-406, 463-472** — `terminal:resize` is sent on every observer tick even when `fit()` changed nothing; harmless (ConPTY no-op) but noisy in the log. Fix: send only when cols/rows changed.
9. **TerminalPanel.svelte:65-96** — no `xterm-addon-unicode11`; emoji width mismatch vs conhost (see hypothesis 6). Fix: load the addon and set `terminal.unicode.activeVersion = '11'`.
10. **ws-server.ts:161-165** — per-instance output batching uses string concatenation (`existing + data`); fine at 60 fps, quadratic under backpressure. Fix: array of chunks joined at flush.
11. **docs/terminal-left-ghosting-findings.md** — its verdict ("Claude CLI bug, nothing in mob can fix it") is wrong per the above; the doc should be superseded so the `CLAUDE_CODE_DISABLE_MOUSE` mitigation is not applied for this symptom.

Tests: `vitest run` → 8 files, 128 tests, all pass. Lint: `eslint src/` → no output.
