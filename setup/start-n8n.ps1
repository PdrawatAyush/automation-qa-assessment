<#
.SYNOPSIS
  Start the local n8n on http://localhost:5678 (data in .local\n8n, git-ignored).

.PARAMETER MockDiscord
  Also start the local Discord stand-in on http://localhost:5680 (for offline testing
  before a real Discord webhook is configured). Payloads are logged to .local\logs\mock-discord.jsonl
.PARAMETER Hidden
  Run in the background (logs in .local\logs) instead of a visible window.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\start-n8n.ps1
#>
param([switch]$MockDiscord, [switch]$Hidden)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$n8n  = Join-Path $root '.local\n8n-runtime\node_modules\.bin\n8n.cmd'
$logs = Join-Path $root '.local\logs'
if (-not (Test-Path $n8n)) { throw 'n8n is not installed yet - run setup\setup-n8n.ps1 first.' }

& (Join-Path $PSScriptRoot 'stop-n8n.ps1')
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# Configuration (inherited by the n8n process)
$env:N8N_USER_FOLDER                   = Join-Path $root '.local\n8n'   # database, encryption key, credentials
$env:N8N_PORT                          = '5678'
$env:N8N_EDITOR_BASE_URL               = 'http://localhost:5678'        # used in execution links sent to Discord
$env:N8N_WEBHOOK_URL                   = 'http://localhost:5678/'
$env:GENERIC_TIMEZONE                  = 'Asia/Kolkata'                 # schedules run on IST
$env:TZ                                = 'Asia/Kolkata'
$env:N8N_SECURE_COOKIE                 = 'false'                        # plain http on localhost only
$env:N8N_DIAGNOSTICS_ENABLED           = 'false'                        # no telemetry leaves this machine
$env:N8N_VERSION_NOTIFICATIONS_ENABLED = 'false'
$env:N8N_TEMPLATES_ENABLED             = 'false'
$env:N8N_PERSONALIZATION_ENABLED       = 'false'
# Run production executions (schedule + webhook) one at a time. The uptime monitor keeps its
# up/down state in workflow static data (last write wins): two overlapping runs could both see
# "up" and both send the same DOWN alert. Found by bonus-uptime-monitor\test-outage.ps1.
# Error workflows are exempt from this queue, so a failing run can still raise its alert.
$env:N8N_CONCURRENCY_PRODUCTION_LIMIT  = '1'

function Wait-LogWritable([string]$file) {
  # A launcher that is still shutting down can hold the previous log open for a moment.
  for ($i = 0; $i -lt 40; $i++) {
    try { [System.IO.File]::WriteAllText($file, ''); return } catch { Start-Sleep -Milliseconds 500 }
  }
  throw "log file is still locked by another process: $file"
}
function Start-Bg([string]$name, [string]$command) {
  if ($Hidden) {
    Wait-LogWritable "$logs\$name.log"
    # Outer quotes: cmd /c strips the first and last quote of the line, keeping the inner ones intact.
    Start-Process cmd.exe -ArgumentList "/c `"$command > `"$logs\$name.log`" 2>&1`"" -WorkingDirectory $root -WindowStyle Hidden
  } else {
    # -EncodedCommand avoids every quoting problem (paths with spaces etc.)
    $script = "`$host.UI.RawUI.WindowTitle = '$name'; & $command"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    Start-Process powershell.exe -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded -WorkingDirectory $root
  }
}

if ($MockDiscord) { Start-Bg 'mock-discord' "node `"$(Join-Path $PSScriptRoot 'mock-discord.mjs')`"" }
Start-Bg 'n8n' "`"$n8n`" start"

$deadline = (Get-Date).AddMinutes(3)
while ($true) {
  try { Invoke-WebRequest 'http://localhost:5678/healthz' -UseBasicParsing -TimeoutSec 5 | Out-Null; break }
  catch { if ((Get-Date) -gt $deadline) { throw 'timed out waiting for n8n on :5678' }; Start-Sleep -Seconds 2 }
}
Write-Host 'n8n is running at http://localhost:5678' -ForegroundColor Green
if ($MockDiscord) { Write-Host 'Discord mock is running at http://localhost:5680 (log: .local\logs\mock-discord.jsonl)' -ForegroundColor Green }
