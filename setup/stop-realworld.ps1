<#
.SYNOPSIS
  Stop the Conduit API (:3000) and frontend (:4200) started by start-realworld.ps1.
  Only processes started from this project's .local folder are stopped; anything else
  listening on those ports is left alone.
#>
$ErrorActionPreference = 'Continue'   # never abort half-way through stopping things
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root '.local\logs'
$ours = @((Join-Path $root '.local\realworld-api'), (Join-Path $root '.local\realworld-frontend'))

# 1. Hidden launchers: cmd.exe /c "... > .local\logs\realworld-*.log". Killing the launcher with /T
#    ends the whole tree (npx -> node -> workers) and releases the log file for the next start.
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*$logs\realworld-*" } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host "stopped launcher (PID $($_.ProcessId))" }

# 2. Anything of ours still listening (e.g. started in a visible window).
foreach ($port in 3000, 4200) {
  $pids = @((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique)
  foreach ($p in $pids) {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine
    if ($ours | Where-Object { $cmd -like "*$_*" }) {
      taskkill /PID $p /T /F 2>$null | Out-Null
      Write-Host "stopped server on port $port (PID $p)"
    } else {
      Write-Warning "port $port is used by another program (PID $p), left alone: $cmd"
    }
  }
}

# 3. Wait until the ports are really free.
$deadline = (Get-Date).AddSeconds(20)
while ((Get-NetTCPConnection -LocalPort 3000, 4200 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
}
