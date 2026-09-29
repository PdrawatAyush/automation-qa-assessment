<#
.SYNOPSIS
  Stop the local n8n (:5678) and the Discord mock (:5680) if they were started from this project.
#>
$ErrorActionPreference = 'Continue'   # never abort half-way through stopping things
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root '.local\logs'
$ours = @((Join-Path $root '.local\n8n-runtime'), (Join-Path $root 'setup\mock-discord.mjs'))

# 1. Hidden launchers (cmd.exe /c "... > .local\logs\n8n.log" / mock-discord.log): /T ends the whole
#    tree (n8n + its task runner) and releases the log file for the next start.
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*$logs\n8n.log*" -or $_.CommandLine -like "*$logs\mock-discord.log*" } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host "stopped launcher (PID $($_.ProcessId))" }

# 2. Anything of ours still listening (e.g. started in a visible window).
foreach ($port in 5678, 5680) {
  $pids = @((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique)
  foreach ($p in $pids) {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine
    if ($ours | Where-Object { $cmd -like "*$_*" }) {
      taskkill /PID $p /T /F 2>$null | Out-Null
      Write-Host "stopped process on port $port (PID $p)"
    } else {
      Write-Warning "port $port is used by another program (PID $p), left alone: $cmd"
    }
  }
}

# 3. Wait until the ports are really free.
$deadline = (Get-Date).AddSeconds(20)
while ((Get-NetTCPConnection -LocalPort 5678, 5680 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
}
