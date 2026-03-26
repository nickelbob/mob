# Mob status hook for Claude Code (Windows PowerShell)
# Reads hook event from stdin, writes instance status to ~/.mob/instances/{id}.json

$ErrorActionPreference = "SilentlyContinue"

$MobDir = Join-Path $env:USERPROFILE ".mob"
$InstancesDir = Join-Path $MobDir "instances"
$MobPort = if ($env:MOB_PORT) { $env:MOB_PORT } else { "4040" }

New-Item -ItemType Directory -Force -Path $InstancesDir | Out-Null

# Read JSON from stdin
$Input = $input | Out-String
$Data = $Input | ConvertFrom-Json

# Determine instance ID
$InstanceId = if ($env:MOB_INSTANCE_ID) { $env:MOB_INSTANCE_ID }
              elseif ($Data.session_id) { $Data.session_id }
              else { "ext-$PID" }

$Cwd = if ($Data.cwd) { $Data.cwd } else { Get-Location }

# Git branch
$GitBranch = ""
try { $GitBranch = git -C $Cwd branch --show-current 2>$null } catch {}

# State from event
$State = switch ($Data.event) {
    "SessionStart" { "running" }
    "SessionEnd"   { "stopped" }
    "Stop"         { "stopped" }
    "PreToolUse"   { "running" }
    "PostToolUse"  { "running" }
    "Notification" { "waiting" }
    "UserPromptSubmit" { "idle" }
    default        { "running" }
}

$ToolName = if ($Data.tool_name) { $Data.tool_name } else { "" }

# Extract user prompt from UserPromptSubmit for auto-naming
$Topic = ""
if ($Data.event -eq "UserPromptSubmit" -and $Data.message) {
    $Topic = ($Data.message -split "`n")[0]
    if ($Topic.Length -gt 80) { $Topic = $Topic.Substring(0, 80) }
}

# Task metadata
$Ticket = ""
$Subtask = ""
$Progress = $null
$TaskFile = Join-Path $Cwd ".mob-task.json"
if (Test-Path $TaskFile) {
    $Task = Get-Content $TaskFile | ConvertFrom-Json
    $Ticket = if ($Task.ticket) { $Task.ticket } else { "" }
    $Subtask = if ($Task.subtask) { $Task.subtask } else { "" }
    $Progress = $Task.progress
}

$Timestamp = [long](Get-Date -UFormat %s) * 1000

$Status = @{
    id = $InstanceId
    cwd = $Cwd
    gitBranch = $GitBranch
    state = $State
    ticket = $Ticket
    subtask = $Subtask
    currentTool = $ToolName
    lastUpdated = $Timestamp
    sessionId = $InstanceId
    topic = $Topic
}
if ($null -ne $Progress) { $Status.progress = $Progress }

$Json = $Status | ConvertTo-Json -Compress

# Atomic write
$TmpFile = Join-Path $InstancesDir ".tmp.$InstanceId.json"
$FinalFile = Join-Path $InstancesDir "$InstanceId.json"
$Json | Out-File -FilePath $TmpFile -Encoding UTF8 -NoNewline
Move-Item -Force $TmpFile $FinalFile

# Best-effort POST
try {
    Invoke-RestMethod -Method Post -Uri "http://localhost:${MobPort}/api/hook" `
        -ContentType "application/json" -Body $Json -TimeoutSec 2 | Out-Null
} catch {}

# Clean up on stop
if ($State -eq "stopped") {
    Start-Job -ScriptBlock {
        Start-Sleep -Seconds 5
        Remove-Item -Force $using:FinalFile
    } | Out-Null
}
