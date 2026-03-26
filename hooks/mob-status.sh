#!/usr/bin/env bash
# Mob status hook for Claude Code
# Reads hook event from stdin, writes instance status to ~/.mob/instances/{id}.json
# and POSTs to the dashboard for instant updates.

set -euo pipefail

MOB_DIR="$HOME/.mob"
INSTANCES_DIR="$MOB_DIR/instances"
MOB_PORT="${MOB_PORT:-4040}"

mkdir -p "$INSTANCES_DIR"

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
HOOK_EVENT=$(echo "$INPUT" | jq -r '.event // empty' 2>/dev/null || echo "")
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")

case "$HOOK_EVENT" in
  "SessionStart") STATE="running" ;;
  "SessionEnd")   STATE="stopped" ;;
  "Stop")         STATE="stopped" ;;
  "PreToolUse")   STATE="running" ;;
  "PostToolUse")  STATE="running" ;;
  "Notification") STATE="waiting" ;;
  "UserPromptSubmit") STATE="idle" ;;
  *)              STATE="running" ;;
esac

# Extract user prompt from UserPromptSubmit for auto-naming
TOPIC=""
if [ "$HOOK_EVENT" = "UserPromptSubmit" ]; then
  RAW_MSG=$(echo "$INPUT" | jq -r '.message // empty' 2>/dev/null || echo "")
  if [ -n "$RAW_MSG" ]; then
    # Truncate to first 80 chars, first line only
    TOPIC=$(echo "$RAW_MSG" | head -1 | cut -c1-80)
  fi
fi

# Extract session_id from hook input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || echo "")

# Read optional task metadata from .mob-task.json in working directory
TICKET=""
SUBTASK=""
PROGRESS=""
if [ -f "$CWD/.mob-task.json" ]; then
  TICKET=$(jq -r '.ticket // empty' "$CWD/.mob-task.json" 2>/dev/null || echo "")
  SUBTASK=$(jq -r '.subtask // empty' "$CWD/.mob-task.json" 2>/dev/null || echo "")
  PROGRESS=$(jq -r '.progress // empty' "$CWD/.mob-task.json" 2>/dev/null || echo "")
fi

TIMESTAMP=$(date +%s)000

# Build JSON status
STATUS_JSON=$(cat <<ENDJSON
{
  "id": "$INSTANCE_ID",
  "cwd": "$CWD",
  "gitBranch": "$GIT_BRANCH",
  "state": "$STATE",
  "ticket": "$TICKET",
  "subtask": "$SUBTASK",
  "topic": "$TOPIC",
  $([ -n "$PROGRESS" ] && echo "\"progress\": $PROGRESS," || echo "")
  "currentTool": "$TOOL_NAME",
  "lastUpdated": $TIMESTAMP,
  "sessionId": "${SESSION_ID:-$INSTANCE_ID}"
}
ENDJSON
)

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
