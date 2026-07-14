#!/usr/bin/env bash
# Mob status hook for Claude Code
# Reads hook event from stdin, writes instance status to ~/.mob/instances/{id}.json
# and POSTs to the dashboard for instant updates.

set -uo pipefail
trap 'exit 0' ERR

MOB_DIR="$HOME/.mob"
INSTANCES_DIR="$MOB_DIR/instances"
MOB_PORT="${MOB_PORT:-4040}"

mkdir -p "$INSTANCES_DIR"

# Only report for mob-launched instances
if [ -z "${MOB_INSTANCE_ID:-}" ]; then
  exit 0
fi

# Read JSON from stdin
INPUT=$(cat)

# Determine instance ID
if [ -n "${MOB_INSTANCE_ID:-}" ]; then
  INSTANCE_ID="$MOB_INSTANCE_ID"
else
  INSTANCE_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || echo "")
  if [ -z "$INSTANCE_ID" ]; then
    INSTANCE_ID="ext-$$"
  fi
fi

# Extract fields from hook input
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || pwd)
[ -z "$CWD" ] && CWD=$(pwd)

# Try to get git branch
GIT_BRANCH=""
if command -v git &>/dev/null && [ -d "$CWD/.git" ] || git -C "$CWD" rev-parse --git-dir &>/dev/null 2>&1; then
  GIT_BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null || echo "")
fi

# Determine state from hook event type
# Claude Code uses hook_event_name, fall back to event for compatibility
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // .event // empty' 2>/dev/null || echo "")
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")

case "$HOOK_EVENT" in
  "SessionStart")        STATE="idle" ;;
  "SessionEnd")          STATE="stopped" ;;
  "Stop")                STATE="idle" ;;
  "PreToolUse")          STATE="running" ;;
  "PostToolUse")         STATE="running" ;;
  "PostToolUseFailure")  STATE="running" ;;
  "Notification")        STATE="idle" ;;
  "UserPromptSubmit")    STATE="running" ;;
  "PermissionRequest")   STATE="waiting" ;;
  "PermissionDenied")    STATE="running" ;;
  "Elicitation")         STATE="waiting" ;;
  "ElicitationResult")   STATE="running" ;;
  *)                     STATE="idle" ;;
esac

# Extract user prompt from UserPromptSubmit for auto-naming
TOPIC=""
if [ "$HOOK_EVENT" = "UserPromptSubmit" ]; then
  RAW_MSG=$(echo "$INPUT" | jq -r '.prompt // .message // empty' 2>/dev/null || echo "")
  if [ -n "$RAW_MSG" ]; then
    # Collapse newlines + trim to ~400 chars (enough for ~4 wrapped lines in the UI)
    TOPIC=$(echo "$RAW_MSG" | tr '\n' ' ' | cut -c1-400)
  fi
fi

# Extract session_id from hook input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || echo "")

# Read optional task metadata from .mob-task.json in working directory
TICKET=""
SUBTASK=""
PROGRESS=""
TICKET_STATUS=""
if [ -f "$CWD/.mob-task.json" ]; then
  TICKET=$(jq -r '.ticket // empty' "$CWD/.mob-task.json" 2>/dev/null || echo "")
  SUBTASK=$(jq -r '.subtask // empty' "$CWD/.mob-task.json" 2>/dev/null || echo "")
  PROGRESS=$(jq -c '.progress // empty' "$CWD/.mob-task.json" 2>/dev/null || echo "")
  TICKET_STATUS=$(jq -r '.ticketStatus // empty' "$CWD/.mob-task.json" 2>/dev/null || echo "")
fi

TIMESTAMP=$(date +%s)000

# Minimal JSON string escaping for the no-jq fallback: backslash, quote,
# and strip control chars.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'
}

# Build JSON status with jq so every field is escaped — prompts, branch
# names, and paths can contain quotes/backslashes/control chars that would
# silently produce invalid JSON if interpolated into a heredoc.
STATUS_JSON=""
if command -v jq &>/dev/null; then
STATUS_JSON=$(jq -n \
  --arg id "$INSTANCE_ID" \
  --arg cwd "$CWD" \
  --arg gitBranch "$GIT_BRANCH" \
  --arg state "$STATE" \
  --arg hookEvent "$HOOK_EVENT" \
  --arg ticket "$TICKET" \
  --arg ticketStatus "$TICKET_STATUS" \
  --arg subtask "$SUBTASK" \
  --arg topic "$TOPIC" \
  --arg currentTool "$TOOL_NAME" \
  --argjson lastUpdated "$TIMESTAMP" \
  --arg sessionId "${SESSION_ID:-$INSTANCE_ID}" \
  --argjson progress "${PROGRESS:-null}" \
  '{
    id: $id,
    cwd: $cwd,
    gitBranch: $gitBranch,
    state: $state,
    hookEvent: $hookEvent,
    ticket: $ticket,
    ticketStatus: $ticketStatus,
    subtask: $subtask,
    topic: $topic,
    currentTool: $currentTool,
    lastUpdated: $lastUpdated,
    sessionId: $sessionId
  } + (if $progress != null then {progress: $progress} else {} end)' 2>/dev/null)
fi

# Fallback when jq is missing or failed: without jq the field-extraction
# above already degraded to empty strings, so only shell-known values need
# escaping. Degraded reporting beats silently disappearing from the dashboard.
if [ -z "$STATUS_JSON" ]; then
  STATUS_JSON=$(cat <<ENDJSON
{
  "id": "$(json_escape "$INSTANCE_ID")",
  "cwd": "$(json_escape "$CWD")",
  "gitBranch": "$(json_escape "$GIT_BRANCH")",
  "state": "$(json_escape "$STATE")",
  "hookEvent": "$(json_escape "$HOOK_EVENT")",
  "ticket": "$(json_escape "$TICKET")",
  "ticketStatus": "$(json_escape "$TICKET_STATUS")",
  "subtask": "$(json_escape "$SUBTASK")",
  "topic": "$(json_escape "$TOPIC")",
  "currentTool": "$(json_escape "$TOOL_NAME")",
  "lastUpdated": $TIMESTAMP,
  "sessionId": "$(json_escape "${SESSION_ID:-$INSTANCE_ID}")"
}
ENDJSON
)
fi

# Atomic write via tmp+rename
TMP_FILE="$INSTANCES_DIR/.tmp.${INSTANCE_ID}.json"
echo "$STATUS_JSON" > "$TMP_FILE"
mv "$TMP_FILE" "$INSTANCES_DIR/${INSTANCE_ID}.json"

# Best-effort POST to dashboard (non-blocking)
if command -v curl &>/dev/null; then
  curl -s -X POST "http://localhost:${MOB_PORT}/api/hook" \
    -H "Content-Type: application/json" \
    -d "$STATUS_JSON" &>/dev/null &
fi

# If session ended, clean up the status file after a delay
if [ "$STATE" = "stopped" ]; then
  (sleep 5 && rm -f "$INSTANCES_DIR/${INSTANCE_ID}.json") &
fi
