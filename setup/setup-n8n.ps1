<#
.SYNOPSIS
  One-time install of self-hosted n8n (the npx route from the brief), pinned to the tested version.
  Installs into .local\n8n-runtime (git-ignored). Equivalent to: npx n8n@2.41.3
  Needs Node.js 24+ (n8n 2.x requirement). Takes several minutes (~2,300 packages).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\setup-n8n.ps1
#>
$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root '.local\n8n-runtime'
$version = '2.41.3'

$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "n8n $version needs Node.js 24 or newer (found $(node -v))." }

$installed = Join-Path $runtime 'node_modules\n8n\package.json'
if ((Test-Path $installed) -and ((Get-Content $installed -Raw | ConvertFrom-Json).version -eq $version)) {
  Write-Host "n8n $version is already installed in .local\n8n-runtime - nothing to do." -ForegroundColor Green
  return
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (-not (Test-Path (Join-Path $runtime 'package.json'))) {
  [System.IO.File]::WriteAllText((Join-Path $runtime 'package.json'), '{ "name": "n8n-runtime", "private": true }')
}
Push-Location $runtime
try {
  npm.cmd install --save-exact --no-audit --no-fund --loglevel=error "n8n@$version"
  if ($LASTEXITCODE -ne 0) { throw "npm install n8n@$version failed" }
} finally { Pop-Location }
Write-Host "n8n $version installed. Start it with: powershell -ExecutionPolicy Bypass -File setup\start-n8n.ps1" -ForegroundColor Green
