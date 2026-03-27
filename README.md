# mob

A local web dashboard for coordinating multiple Claude Code CLI sessions. Launch, monitor, and switch between Claude instances working across different projects — all from a single browser tab.

## Features

- **Launch and manage** multiple Claude Code sessions from a web UI
- **Live terminal** view with full I/O for each session (xterm.js)
- **Session persistence** — sessions survive server restarts and auto-resume
- **Auto-naming** — sessions are named based on what Claude is working on, refreshed every 5 prompts
- **Hook integration** — external Claude instances report status via hook scripts
- **Terminal state fallback** — detects running/waiting/idle from terminal output when hooks are silent
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
git clone https://github.com/nickelbob/mob.git
cd mob
npm install
```

If you see errors about missing native modules, run:

```bash
npm run setup
```

This detects your platform and installs the correct native binaries for node-pty and rollup. It also runs automatically before `npm run dev` and `npm run build`.

### Install Claude Code Hooks

To enable status reporting (state, branch, auto-naming) from Claude instances launched by mob:

```bash
npm run install-hooks
```

This adds hook entries to `~/.claude/settings.json` that report instance status back to the dashboard.

### Run

**Development** (hot-reload):

```bash
npm run dev
```

Opens the backend on `http://localhost:4040` and the Vite dev server on `http://localhost:4041`. Use port 4041 during development.

**Production**:

```bash
npm run build
npm start
```

Everything is served from `http://localhost:4040`.

## Usage

### Launching Instances

1. Click **+ Launch Instance** (or press **Alt+N**)
2. Type or paste a working directory path (autocomplete suggests as you type)
3. Optionally set a name, model, and permission mode
4. Click **Launch** (or press **Ctrl+Enter**)

The instance spawns a shell, loads your environment, and starts Claude Code in the specified directory.

### Keyboard Shortcuts

All shortcuts are rebindable in **Settings > Shortcuts**.

| Default Shortcut | Action |
|---|---|
| **Alt+N** | Open launch dialog |
| **Alt+B** | Toggle sidebar |
| **Alt+Up/Down** | Cycle through sessions |
| **Alt+R** | Resume selected instance |
| **Ctrl/Cmd+1-9** | Jump to session by position |
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
- **General** — sidebar default state, terminal cache size, browser notifications
- **JIRA** — base URL, email, and API token for ticket status integration

### Browser Notifications

When enabled (default: on), mob sends a browser notification when an instance transitions to "waiting" while the tab is not focused. Grant notification permission when prompted on first load.

### JIRA Integration

If configured in Settings > JIRA, mob will:
- Extract ticket keys (e.g., `PROJ-123`) from git branch names
- Show clickable ticket links in instance cards
- Fetch and display the current ticket status from JIRA

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
npm run uninstall-hooks
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

1. Make sure hooks are installed: `npm run install-hooks`
2. Check `~/.claude/settings.json` has entries for `PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`, and `Notification`
3. On Windows, ensure PowerShell can run the hook script (execution policy)

### Instance stuck in wrong state

If hooks aren't firing (crash, subtask weirdness), the terminal state fallback should correct the state within ~15 seconds. If an instance shows as running but the PTY process is dead, it will be marked stopped automatically on the next stale check cycle.

## Changelog

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
