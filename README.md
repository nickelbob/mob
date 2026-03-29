# mob

A local web dashboard for coordinating multiple Claude Code CLI sessions. Launch, monitor, and switch between Claude instances working across different projects — all from a single browser tab.

![mob dashboard](docs/screenshot.png)

## Features

- **Launch and manage** multiple Claude Code sessions from a web UI
- **Live terminal** view with full I/O for each session (xterm.js)
- **Project grouping** — instances auto-group by project directory in the sidebar when working across repos
- **Session persistence** — sessions survive server restarts and auto-resume
- **Auto-naming** — sessions are named based on what Claude is working on, refreshed every 5 prompts
- **Per-project config** — `.mob/config.json` for setup/teardown scripts and launch defaults per repo
- **Shell readiness detection** — waits for shell prompt before injecting commands (no more garbled output)
- **Hook integration** — external Claude instances report status via hook scripts
- **Terminal state fallback** — detects running/waiting/idle from terminal output when hooks are silent
- **Notification sounds** — optional audio ping when an instance needs input (in addition to browser notifications)
- **Browser notifications** — get notified when an instance needs input while you're in another tab
- **Git branch tracking** — see which branch each session is on, with tiered refresh rates
- **JIRA integration** — auto-detect ticket keys from branch names, show ticket status
- **Configurable settings** — keyboard shortcuts, launch defaults, terminal appearance, and more
- **Keyboard shortcuts** — cycle sessions, jump by number, clipboard support, all rebindable
- **Visual indicators** — pulsing "Needs Input" badge when Claude is waiting for you
- **Sidebar** — collapsible instance list, sorted by creation time with stopped instances last

## Prerequisites

- **Node.js** 18+ (tested with 20.x)
- **Claude Code CLI** installed and authenticated (`claude` command available in your terminal)
- **git** (for branch detection)

## Quick Start

```bash
npm install -g mob-coordinator
mob
```

Open `http://localhost:4040` in your browser.

Claude Code hooks are installed automatically on first launch. These enable status reporting (state, branch, auto-naming) from Claude instances. To manually manage hooks:

```bash
mob install-hooks      # Re-install hooks
mob uninstall-hooks    # Remove hooks
mob --no-hooks         # Start without installing/updating hooks
```

### Development

To contribute or run from source:

```bash
git clone https://github.com/nickelbob/mob.git
cd mob
npm install
npm run dev
```

Opens the backend on `http://localhost:4040` and the Vite dev server on `http://localhost:4041`. Use port 4041 during development.

If you see errors about missing native modules, run `npm run setup` to auto-detect and install the correct platform-specific binaries.

## Usage

### Launching Instances

1. Click **+ Launch Instance** (or press **Alt/Option+N**)
2. Type or paste a working directory path (autocomplete suggests as you type)
3. Optionally set a name, model, and permission mode
4. Click **Launch** (or press **Ctrl+Enter**)

The instance spawns a shell, loads your environment, and starts Claude Code in the specified directory.

### Keyboard Shortcuts

All shortcuts are rebindable in **Settings > Shortcuts**.

| Default Shortcut | Action |
|---|---|
| **Alt/Option+N** | Open launch dialog |
| **Alt/Option+B** | Toggle sidebar |
| **Alt/Option+Up/Down** | Cycle through sessions |
| **Alt/Option+R** | Resume selected instance |
| **Alt/Option+W** | Kill selected instance |
| **Alt/Option+X** | Dismiss selected instance |
| **Alt/Option+,** | Open settings |
| **Alt/Option+1-9** | Jump to session by position |
| **Ctrl+C** | Copy selected text (or send interrupt if no selection) |
| **Ctrl+V** | Paste from clipboard into terminal |
| **Ctrl+Enter** | Launch instance (in launch dialog) |
| **Escape** | Close dialogs |

### Session States

| State | Meaning |
|---|---|
| **Running** | Claude is working (using tools, generating response) |
| **Needs Input** | Claude is waiting for your input (permission prompt, question) |
| **Idle** | Session is idle at a prompt |
| **Launching** | Session is starting up |
| **Stopped** | Session ended (can be resumed) |

State detection uses hooks as the primary source. When hooks are silent for 15+ seconds, mob falls back to parsing terminal output for spinner characters, prompt patterns, and input requests. Dead PTY processes are detected and marked stopped automatically.

### Settings

Open via the gear icon or **Settings** in the UI. Configurable sections:

- **Shortcuts** — rebind any keyboard shortcut
- **Launch Defaults** — default working directory, model, permission mode, auto-naming
- **Terminal** — font size, cursor style, scrollback lines
- **General** — sidebar default state, terminal cache size, browser notifications, notification sounds
- **JIRA** — base URL, email, and API token for ticket status integration

### Per-Project Configuration

Create a `.mob/config.json` in any project directory to customize behavior for that repo:

```json
{
  "setup": ["nvm use", "source .venv/bin/activate"],
  "teardown": ["deactivate"],
  "defaults": {
    "model": "claude-sonnet-4-6",
    "permissionMode": "plan"
  }
}
```

- **setup** — shell commands run before Claude starts (after shell is ready)
- **teardown** — shell commands run when the instance is killed (best-effort)
- **defaults** — pre-fill launch settings (model, permissionMode, autoName)

### Browser Notifications

When enabled (default: on), mob sends a browser notification when an instance transitions to "waiting" while the tab is not focused. Grant notification permission when prompted on first load.

You can also enable **notification sounds** in Settings > General to get an audio ping when an instance needs input, even when the tab is visible.

### JIRA Integration

If configured in Settings > JIRA, mob will:
- Extract ticket keys (e.g., `PROJ-123`) from git branch names
- Show clickable ticket links in instance cards
- Fetch and display the current ticket status from JIRA

JIRA credentials are stored in `~/.mob/settings.json` with 0600 permissions (owner read/write only), similar to how `~/.npmrc` or `~/.netrc` store tokens. The API token is redacted in the web UI. We recommend using a JIRA API token with minimal (read-only) permissions.

### External Instances

Claude Code sessions started outside of mob (e.g., directly in a terminal) will appear in the dashboard as "external" instances if the hooks are installed. They show status, branch, and state but don't provide terminal I/O.

## Architecture

Three layers:

- **Shared** (`src/shared/`) — WebSocket protocol types, constants, and settings schema
- **Server** (`src/server/`) — Node.js backend: Express + ws + node-pty + chokidar
- **Client** (`src/client/`) — Svelte 5 app with xterm.js

See `CLAUDE.md` for detailed architecture documentation.

## Uninstalling Hooks

```bash
mob uninstall-hooks
```

## Troubleshooting

### Missing native modules after `npm install`

npm has a [known bug](https://github.com/npm/cli/issues/4828) with optional platform-specific dependencies. Run `npm run setup` to auto-detect and install the correct ones. If that doesn't work:

```bash
# Clean reinstall
rm -rf node_modules package-lock.json
npm install
npm run setup
```

### Port 4040 already in use

Another instance of mob (or another process) is using the port. Kill it or set a custom port:

```bash
MOB_PORT=4050 npm run dev
```

### Hooks not reporting status

1. Hooks are auto-installed on startup. To force re-install: `mob install-hooks`
2. Check `~/.claude/settings.json` has entries for `PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`, and `Notification`
3. On Windows, ensure PowerShell can run the hook script (execution policy)

### `npm audit` reports vulnerabilities

`npm audit` may report moderate vulnerabilities in vite (a dev-only build tool). These are **not included** in the published npm package — only the pre-built `dist/` directory ships. You can verify with `npm ls vite` in the installed package.

### Instance stuck in wrong state

If hooks aren't firing (crash, subtask weirdness), the terminal state fallback should correct the state within ~15 seconds. If an instance shows as running but the PTY process is dead, it will be marked stopped automatically on the next stale check cycle.

## FAQ

**Why not just use tmux/screen?**
tmux gives you multiple terminals. mob adds a Claude-specific dashboard layer: visual state indicators (working/waiting/idle), auto-naming sessions based on what Claude is doing, JIRA ticket detection from branches, browser notifications when Claude needs your input, and one-click session resume.

**Why only Claude Code? What about Cursor/Copilot/Aider?**
mob uses Claude Code's hook system for real-time status reporting. Supporting other tools would require each to expose a similar hook/event API. PRs welcome if someone wants to add support for other tools.

**Is remote/team use planned?**
mob is a personal productivity tool by design. Localhost-only means zero auth, zero cloud dependency, zero data leaving your machine.

**The name "mob" conflicts with mob.sh / mob programming.**
The npm package is `mob-coordinator` to avoid conflicts. The CLI command is `mob` for brevity.

**Does mob modify my Claude Code settings?**
Hooks are auto-installed on first launch to enable status reporting. They are additive and don't overwrite existing configuration. You can skip them with `mob --no-hooks` or remove them with `mob uninstall-hooks`.

## Changelog

### 0.5.0

- **Custom project groups** — set a group name in the launch dialog or edit it after creation; instances with the same group merge
- **Inline instance editing** — pencil icon on instance cards lets you edit name, group, model, and permission mode live
- **Smart repo grouping** — clones of the same repo auto-group via git remote URL detection; case-insensitive matching
- **Alt+Left/Right** — collapse/expand the project group of the selected instance
- Fix browser autofill populating the working directory field
- Fix browse button triggering on Enter in launch dialog

### 0.4.2

- **Create & Launch** — launching in a non-existent directory now prompts to create it instead of spawning a blank session
- **Collapsed group awareness** — cycling with Alt+Up/Down into a collapsed project group shows a toast and highlights the group header
- **Focus management** — terminal refocuses automatically when launch or settings dialog closes
- **Autocomplete UX** — Escape dismisses the directory dropdown without closing the dialog; dropdown is smaller and dismisses on click
- Fix instance cycling order to match grouped sidebar layout
- Fix teardown RCE: replaced silent `sh -c` with visible PTY writes (security)

### 0.4.0

- **Project grouping** — sidebar auto-groups instances by project directory when working across 2+ repos, with collapsible headers
- **Per-project config** — `.mob/config.json` supports setup/teardown scripts and launch defaults per repo
- **Shell readiness detection** — replaces hardcoded 500ms delay with prompt detection + 5s timeout fallback
- **Notification sounds** — opt-in audio ping when an instance needs input (Settings > General)
- **Backpressure management** — terminal data batched at ~60fps with per-client buffer caps to prevent memory growth
- **Tree-kill** — reliably terminates entire process tree (shell + claude + children) on kill
- **Atomic file writes** — session and scrollback files use write-then-rename to prevent corruption on crash
- **ANSI escape filtering** — terminal state detector strips escape sequences for more reliable pattern matching

### 0.3.7

- Add WebSocket origin validation to prevent cross-site WebSocket hijacking

### 0.3.6

- Harden auto-updater: validate versions, use `execFileSync` instead of shell, sanitize error output
- Graceful shutdown with PTY cleanup and state persistence
- Active session warning before updates

### 0.3.5

- Self-updating: check npm registry for new versions and update in-place from the UI

### 0.3.4

- "Resume All" button when multiple stopped sessions exist

### 0.3.3

- Test suite for core server and shared logic (sanitization, scrollback buffer, settings, terminal state detection, keyboard shortcuts)

### 0.3.1

- Collapsed sidebar status squares for at-a-glance state
- Auto-scroll terminal to bottom on session switch

### 0.3.0

- Auto-install Claude Code hooks on server startup — no manual setup required
- Add `mob install-hooks` and `mob uninstall-hooks` CLI subcommands
- Include hook scripts in npm package
- Add landing page website for GitHub Pages

### 0.2.1

- Fix false "Needs Input" showing when Claude finishes a task (completion notifications no longer trigger waiting state)
- npm package available: `npm install -g mob-coordinator`

### 0.2.0

- Terminal-based state fallback when hooks are silent (detects running/waiting/idle from scrollback)
- Dead PTY detection — instances with crashed processes auto-transition to stopped
- Browser notifications for waiting instances (configurable)
- Settings system with persistent configuration (shortcuts, launch defaults, terminal, general, JIRA)
- JIRA integration — ticket key extraction from branches, status display, clickable links
- Tiered git branch refresh (10s for active, 60s for idle instances)
- Fix auto-name state transfer on session resume
- Terminal auto-focus and scroll-to-bottom on session switch
- Collapsible sidebar
- Security hardening and input sanitization

### 0.1.0

- Initial release
- Launch and manage multiple Claude Code sessions
- Live terminal with xterm.js
- Session persistence and resume
- Auto-naming from Claude's topic/subtask
- Hook-based status reporting
- Git branch tracking
- Keyboard shortcuts and clipboard support
