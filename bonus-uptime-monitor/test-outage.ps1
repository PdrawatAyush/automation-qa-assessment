<#
.SYNOPSIS
  End-to-end test of the uptime monitor with a REAL outage (nothing simulated):
  baseline check -> stop the Conduit API -> check twice (1 alert, then silence) ->
  restart the API -> check (recovery alert) -> daily report on demand.
  Results are written to bonus-uptime-monitor\test-results.md

  Needs: Conduit running (setup\start-realworld.ps1), n8n + Discord mock running
  (setup\start-n8n.ps1 -MockDiscord) and provisioned (node setup\provision-n8n.mjs).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File bonus-uptime-monitor\test-outage.ps1
#>
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$api   = Join-Path $root '.local\realworld-api'
$log   = Join-Path $root '.local\logs\realworld-api.log'
$token = (Get-Content (Join-Path $root '.local\n8n-local.json') -Raw | ConvertFrom-Json).webhookToken
$rows  = @()

function Invoke-Hook([string]$path) {
  Invoke-RestMethod "http://localhost:5678/webhook/$path" -Headers @{ 'X-Webhook-Token' = $token } -TimeoutSec 120
}
function Get-MonitorMessages {
  # Windows PowerShell 5.1 emits a JSON array from Invoke-RestMethod as ONE pipeline object;
  # assigning it first and wrapping with @() enumerates the individual messages.
  $all = Invoke-RestMethod 'http://localhost:5680/__messages'
  @($all) | Where-Object { $_.author.username -eq 'Uptime Monitor' }
}
function Wait-Api([bool]$up) {
  $deadline = (Get-Date).AddMinutes(2)
  while ($true) {
    $ok = $true; try { Invoke-WebRequest http://localhost:3000/api/tags -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { $ok = $false }
    if ($ok -eq $up) { return }
    if ((Get-Date) -gt $deadline) { throw "API did not become $(if ($up) { 'reachable' } else { 'unreachable' })" }
    Start-Sleep -Seconds 2
  }
}
function Add-Row([string]$step, [bool]$pass, [string]$evidence) {
  $script:rows += [pscustomobject]@{ Step = $step; Pass = $pass; Evidence = $evidence }
  Write-Host ("{0}  {1}`n      {2}" -f $(if ($pass) { 'PASS' } else { 'FAIL' }), $step, $evidence) -ForegroundColor $(if ($pass) { 'Green' } else { 'Red' })
}

$before = @(Get-MonitorMessages).Count

$a = Invoke-Hook 'uptime-check'
Add-Row '1. Baseline: both targets up' ($a.up -eq 2) ($a.results -join ' | ')

# Real outage: stop only the Conduit API (its hidden launcher + server process tree)
& {
  $ErrorActionPreference = 'Continue'
  $logs = Join-Path $root '.local\logs'
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*$logs\realworld-api*" } |
    ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
  foreach ($p in ((Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique)) {
    if ((Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine -like "*$api*") { taskkill /PID $p /T /F 2>$null | Out-Null }
  }
}
Wait-Api $false

# Two checks at the SAME time (like a manual check overlapping the 5-minute schedule):
# both must see the outage, but the team must get exactly ONE alert.
$outs = 1..2 | ForEach-Object { Join-Path $root ".local\logs\uptime-check-$_.json" }
$sw = [Diagnostics.Stopwatch]::StartNew()
$procs = $outs | ForEach-Object {
  Start-Process curl.exe -ArgumentList '-s', '--max-time', '120', '-H', "`"X-Webhook-Token: $token`"", 'http://localhost:5678/webhook/uptime-check' -RedirectStandardOutput $_ -NoNewWindow -PassThru
}
$procs | Wait-Process
$b = $outs | ForEach-Object { Get-Content $_ -Raw | ConvertFrom-Json }
$down = @(Get-MonitorMessages | Select-Object -Skip $before | Where-Object { $_.content -like '*Conduit API is DOWN*' })
$bothSawIt = @($b | Where-Object { ($_.results -join ' ') -like '*Conduit API: DOWN*' }).Count -eq 2
Add-Row '2. API stopped, 2 overlapping checks -> exactly 1 DOWN alert' ($bothSawIt -and $down.Count -eq 1) ("both checks done in {0:N1}s; alerts sent by the checks: {1}; DOWN alerts received: {2}; alert: {3}" -f $sw.Elapsed.TotalSeconds, (($b | ForEach-Object { $_.alertsSent }) -join ' + '), $down.Count, ($down[0].content -replace "`n", ' '))

$c = Invoke-Hook 'uptime-check'
$down = @(Get-MonitorMessages | Select-Object -Skip $before | Where-Object { $_.content -like '*Conduit API is DOWN*' })
Add-Row '3. Still down -> no duplicate alert' (($c.results -join ' ') -like '*Conduit API: DOWN*' -and $down.Count -eq 1) ("alerts sent by this check: $($c.alertsSent); DOWN alerts in total: $($down.Count)")

# Recovery (wait until the old launcher has released the log file, then start the API again)
for ($i = 0; $i -lt 40; $i++) { try { [System.IO.File]::WriteAllText($log, ''); break } catch { Start-Sleep -Milliseconds 500 } }
Start-Process cmd.exe -ArgumentList "/c `"npx.cmd nitro dev --port 3000 > `"$log`" 2>&1`"" -WorkingDirectory $api -WindowStyle Hidden
Wait-Api $true
$d = Invoke-Hook 'uptime-check'
$rec = @(Get-MonitorMessages | Select-Object -Skip $before | Where-Object { $_.content -like '*Conduit API recovered*' })
Add-Row '4. API back -> RECOVERED alert' ($d.up -eq 2 -and $rec.Count -eq 1) (($d.results -join ' | ') + '; alert: ' + $rec[0].content)

$r = Invoke-Hook 'uptime-report'
Add-Row '5. Daily summary on demand' ($r.content -like '*Daily uptime report*' -and $r.content -like '*incident*') ($r.content -replace "`n", ' / ')

$passed = @($rows | Where-Object Pass).Count
$md = @('# Bonus – uptime monitor test results', '',
  "Run: $((Get-Date).ToString('yyyy-MM-dd HH:mm')) IST · real outage (the Conduit API process was stopped and restarted) · Discord replaced by the local mock · **$passed/$($rows.Count) passed**", '',
  '| Step | Result | Evidence |', '|---|---|---|') + ($rows | ForEach-Object { "| $($_.Step) | $(if ($_.Pass) { '✅ PASS' } else { '❌ FAIL' }) | $($_.Evidence -replace '\|', '\|') |" })
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'test-results.md'), ($md -join "`n") + "`n")
Write-Host "$passed/$($rows.Count) passed - written to bonus-uptime-monitor\test-results.md"
if ($passed -ne $rows.Count) { exit 1 }
