<#
.SYNOPSIS
  Happy-path test of the Morning Brief webhook with curl (as suggested in the brief).
  Reads the local webhook token from .local\n8n-local.json and calls the PRODUCTION webhook,
  i.e. the published workflow runs exactly as it would on its hourly schedule.

.PARAMETER Topic     Optional GitHub topic to brief on (default: the workflow's Config value, "ai-agents").
.PARAMETER Simulate  Optional: "github-down" exercises the handled error path (GitHub answers 404).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File task2-n8n-workflow\test-webhook.ps1
  powershell -ExecutionPolicy Bypass -File task2-n8n-workflow\test-webhook.ps1 -Simulate github-down
#>
param([string]$Topic, [string]$Simulate)
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$token = (Get-Content (Join-Path $root '.local\n8n-local.json') -Raw | ConvertFrom-Json).webhookToken

$query = @()
if ($Topic)    { $query += "topic=$Topic" }
if ($Simulate) { $query += "simulate=$Simulate" }
$url = 'http://localhost:5678/webhook/morning-brief'
if ($query) { $url += '?' + ($query -join '&') }

Write-Host "curl -H 'X-Webhook-Token: ***' $url"
$out  = @(curl.exe -s --max-time 120 -w "`n%{http_code}" -H "X-Webhook-Token: $token" $url)
$code = $out[-1]
$json = ($out[0..($out.Count - 2)] -join "`n")
Write-Host "HTTP $code"
Write-Host $json

$result = $json | ConvertFrom-Json
if (-not $Simulate -and $code -eq '200' -and $result.status -eq 'digest sent' -and $result.repos -ge 1) {
  Write-Host "PASS: digest with $($result.repos) repos ($($result.breakout) breakout) delivered to Discord" -ForegroundColor Green; exit 0
}
if ($Simulate -eq 'github-down' -and $code -eq '200' -and $result.status -like 'github unavailable*') {
  Write-Host 'PASS: GitHub outage handled - alert delivered to Discord instead of failing silently' -ForegroundColor Green; exit 0
}
Write-Host 'FAIL: unexpected response' -ForegroundColor Red
exit 1
