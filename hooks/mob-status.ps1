# Mob status hook for Claude Code (Windows PowerShell)
# Reads hook event from stdin, writes instance status to ~/.mob/instances/{id}.json

$MobDir = Join-Path $env:USERPROFILE ".mob"
$InstancesDir = Join-Path $MobDir "instances"
$LogFile = Join-Path $MobDir "hook-debug.log"
$MobPort = if ($env:MOB_PORT) { $env:MOB_PORT } else { "4040" }

New-Item -ItemType Directory -Force -Path $InstancesDir | Out-Null

function Log($msg) {
    $ts = Get-Date -Format "HH:mm:ss.fff"
    "$ts $msg" | Out-File -Append -FilePath $LogFile -Encoding UTF8
}

Log "=== Hook started (PID=$PID) ==="

# Only report for mob-launched instances
if (-not $env:MOB_INSTANCE_ID) {
    Log "No MOB_INSTANCE_ID, skipping"
    exit 0
}

# Read JSON from stdin
try {
    $RawInput = [Console]::In.ReadToEnd()
} catch {
    Log "stdin read FAILED: $_"
    exit 0
}

if (-not $RawInput -or $RawInput.Trim().Length -eq 0) {
    Log "Empty stdin, exiting"
    exit 0
}

try {
    $Data = $RawInput | ConvertFrom-Json
} catch {
    Log "JSON parse FAILED: $_"
    exit 0
}

# Claude Code uses hook_event_name, not event
$HookEvent = if ($Data.hook_event_name) { "$($Data.hook_event_name)" }
             elseif ($Data.event) { "$($Data.event)" }
             else { "" }
Log "Event=$HookEvent"

# Determine instance ID
$InstanceId = if ($env:MOB_INSTANCE_ID) { $env:MOB_INSTANCE_ID }
              elseif ($Data.session_id) { "$($Data.session_id)" }
              else { "ext-$PID" }
Log "InstanceId=$InstanceId"

$Cwd = if ($Data.cwd) { "$($Data.cwd)" } else { (Get-Location).Path }

# Git branch
$GitBranch = ""
try { $GitBranch = git -C "$Cwd" branch --show-current 2>$null } catch {}

# State from event
$State = switch ($HookEvent) {
    "SessionStart" { "running" }
    "SessionEnd"   { "stopped" }
    "Stop"         { "stopped" }
    "PreToolUse"   { "running" }
    "PostToolUse"  { "running" }
    "Notification" { "waiting" }
    "UserPromptSubmit" { "idle" }
    default        { "running" }
}
Log "State=$State"

$ToolName = if ($Data.tool_name) { "$($Data.tool_name)" } else { "" }

# Extract user prompt from UserPromptSubmit for auto-naming
# Claude Code sends the prompt in the "prompt" field
$Topic = ""
if ($HookEvent -eq "UserPromptSubmit" -and $Data.prompt) {
    $Topic = ("$($Data.prompt)" -split "`n")[0]
    if ($Topic.Length -gt 80) { $Topic = $Topic.Substring(0, 80) }
    Log "Topic=$Topic"
}

# Task metadata
$Ticket = ""
$Subtask = ""
$Progress = $null
$TicketStatus = ""
$TaskFile = Join-Path $Cwd ".mob-task.json"
if (Test-Path $TaskFile) {
    $Task = Get-Content $TaskFile | ConvertFrom-Json
    $Ticket = if ($Task.ticket) { "$($Task.ticket)" } else { "" }
    $Subtask = if ($Task.subtask) { "$($Task.subtask)" } else { "" }
    $Progress = $Task.progress
    $TicketStatus = if ($Task.ticketStatus) { "$($Task.ticketStatus)" } else { "" }
}

$Timestamp = [long](Get-Date -UFormat %s) * 1000

$Status = @{
    id = $InstanceId
    cwd = "$Cwd"
    gitBranch = "$GitBranch"
    state = "$State"
    ticket = "$Ticket"
    ticketStatus = "$TicketStatus"
    subtask = "$Subtask"
    currentTool = "$ToolName"
    lastUpdated = $Timestamp
    sessionId = "$InstanceId"
    topic = "$Topic"
}
if ($null -ne $Progress) { $Status.progress = $Progress }

$Json = $Status | ConvertTo-Json -Compress
Log "JSON=$Json"

# Atomic write
try {
    $TmpFile = Join-Path $InstancesDir ".tmp.$InstanceId.json"
    $FinalFile = Join-Path $InstancesDir "$InstanceId.json"
    $Json | Out-File -FilePath $TmpFile -Encoding UTF8 -NoNewline
    Move-Item -Force $TmpFile $FinalFile
    Log "File written OK"
} catch {
    Log "File write FAILED: $_"
}

# Best-effort POST (bypass system proxy, use 127.0.0.1 to avoid IPv6)
try {
    $wc = New-Object System.Net.WebClient
    $wc.Proxy = $null
    $wc.Headers.Add("Content-Type", "application/json")
    $wc.UploadString("http://127.0.0.1:${MobPort}/api/hook", $Json) | Out-Null
    Log "POST OK"
} catch {
    Log "POST failed: $_"
}

# Clean up on stop
if ($State -eq "stopped") {
    Start-Job -ScriptBlock {
        Start-Sleep -Seconds 5
        Remove-Item -Force $using:FinalFile
    } | Out-Null
}

Log "=== Hook finished ==="
