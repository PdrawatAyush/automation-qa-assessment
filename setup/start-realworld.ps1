<#
.SYNOPSIS
  Start the app under test: API on http://localhost:3000/api, frontend on http://localhost:4200

.PARAMETER ResetDb
  Start from an empty database (do this before running the QA suite for identical results).
.PARAMETER Hidden
  Run both servers in the background (logs in .local\logs) instead of two visible windows.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\start-realworld.ps1 -ResetDb
#>
param([switch]$ResetDb, [switch]$Hidden)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$api  = Join-Path $root '.local\realworld-api'
$web  = Join-Path $root '.local\realworld-frontend'
$logs = Join-Path $root '.local\logs'

if (-not (Test-Path (Join-Path $api 'node_modules')) -or -not (Test-Path (Join-Path $web 'node_modules'))) {
  throw 'App not installed yet - run setup\setup-realworld.ps1 first.'
}

& (Join-Path $PSScriptRoot 'stop-realworld.ps1')   # never run two copies

if ($ResetDb) {
  Remove-Item (Join-Path $api 'dev.db') -ErrorAction SilentlyContinue
  Push-Location $api
  try { npx.cmd prisma db push | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'prisma db push failed' } } finally { Pop-Location }
  Write-Host 'database reset (empty)'
}

New-Item -ItemType Directory -Force -Path $logs | Out-Null
function Wait-LogWritable([string]$file) {
  # A launcher that is still shutting down can hold the previous log open for a moment.
  for ($i = 0; $i -lt 40; $i++) {
    try { [System.IO.File]::WriteAllText($file, ''); return } catch { Start-Sleep -Milliseconds 500 }
  }
  throw "log file is still locked by another process: $file"
}
function Start-Server([string]$name, [string]$dir, [string]$command) {
  if ($Hidden) {
    Wait-LogWritable "$logs\$name.log"
    # Outer quotes: cmd /c strips the first and last quote of the line, keeping the inner ones intact.
    Start-Process cmd.exe -ArgumentList "/c `"$command > `"$logs\$name.log`" 2>&1`"" -WorkingDirectory $dir -WindowStyle Hidden
  } else {
    # -EncodedCommand avoids every quoting problem (paths with spaces etc.)
    $script = "`$host.UI.RawUI.WindowTitle = '$name'; $command"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    Start-Process powershell.exe -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded -WorkingDirectory $dir
  }
}
Start-Server 'realworld-api' $api 'npx.cmd nitro dev --port 3000'
Start-Server 'realworld-frontend' $web 'npx.cmd ng serve --port 4200 --no-open'

foreach ($url in 'http://localhost:3000/api/tags', 'http://localhost:4200/') {
  $deadline = (Get-Date).AddMinutes(3)
  while ($true) {
    try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5 | Out-Null; break }
    catch { if ((Get-Date) -gt $deadline) { throw "timed out waiting for $url" }; Start-Sleep -Seconds 2 }
  }
  Write-Host "up: $url"
}
Write-Host 'Conduit is running at http://localhost:4200 (API: http://localhost:3000/api)' -ForegroundColor Green
