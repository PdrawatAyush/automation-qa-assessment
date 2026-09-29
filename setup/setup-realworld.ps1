<#
.SYNOPSIS
  One-time setup of the app tested in Task 1: RealWorld "Conduit"
  (Angular frontend + Nitro/Prisma/SQLite API), run fully locally.

.DESCRIPTION
  - clones both repositories at the exact commits that were tested (pinned = reproducible)
  - points the frontend at the local API (the only code change; upstream hard-codes the public API)
  - installs dependencies, generates the Prisma client and creates the SQLite database
  - writes a local-only .env with a random JWT secret
  Everything is created under ..\.local\ (git-ignored).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\setup-realworld.ps1
#>
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$local = Join-Path $root '.local'
$api   = Join-Path $local 'realworld-api'
$web   = Join-Path $local 'realworld-frontend'

$API_REPO = 'https://github.com/realworld-apps/nitro-prisma-zod-realworld-example-app.git'
$API_SHA  = 'c8c66858a436a6e07f445fffe2253a65ff6dcb58'   # 2026-05-05
$WEB_REPO = 'https://github.com/realworld-apps/angular-realworld-example-app.git'
$WEB_SHA  = 'dd99ed2cf39c805d719f943c5d7061a5683d98a8'   # 2026-05-13

function Invoke-Step([string]$what, [scriptblock]$cmd) {
  Write-Host "==> $what" -ForegroundColor Cyan
  $ErrorActionPreference = 'Continue'   # git/npm write progress to stderr; success is judged by exit code
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

New-Item -ItemType Directory -Force -Path $local | Out-Null

# core.longpaths: the RealWorld submodule has very long file names; without it Windows' 260-char
# path limit breaks the checkout when this folder sits deep in the file system.
if (-not (Test-Path $api)) { Invoke-Step 'clone API' { git -c core.longpaths=true clone -q $API_REPO $api } }
Invoke-Step 'checkout tested API commit' { git -c core.longpaths=true -C $api checkout -q $API_SHA }

if (-not (Test-Path $web)) { Invoke-Step 'clone frontend' { git -c core.longpaths=true clone -q $WEB_REPO $web } }
Invoke-Step 'checkout tested frontend commit' { git -c core.longpaths=true -C $web checkout -q $WEB_SHA }
Invoke-Step 'fetch shared theme (git submodule)' { git -c core.longpaths=true -C $web submodule update --init -q }

# Upstream hard-codes the public API; point it at the local one (UTF-8 without BOM).
$interceptor = Join-Path $web 'src\app\core\interceptors\api.interceptor.ts'
$code = [System.IO.File]::ReadAllText($interceptor)
[System.IO.File]::WriteAllText($interceptor, $code.Replace('https://api.realworld.show/api', 'http://localhost:3000/api'))
Write-Host '==> frontend now calls http://localhost:3000/api' -ForegroundColor Cyan

Push-Location $api
try {
  Invoke-Step 'npm install (API)' { npm.cmd install --no-audit --no-fund --loglevel=error }
  Invoke-Step 'prisma generate' { npx.cmd prisma generate }
  if (-not (Test-Path '.env')) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [System.IO.File]::WriteAllText((Join-Path $api '.env'), "JWT_SECRET=$([Convert]::ToBase64String($bytes))`nDATABASE_URL=file:./dev.db`n")
    Write-Host '==> wrote .local\realworld-api\.env (random local JWT secret)' -ForegroundColor Cyan
  }
  Invoke-Step 'create SQLite database' { npx.cmd prisma db push }
} finally { Pop-Location }

Push-Location $web
try { Invoke-Step 'npm install (frontend)' { npm.cmd install --no-audit --no-fund --loglevel=error } } finally { Pop-Location }

Write-Host "`nSetup complete. Start the app with:  powershell -ExecutionPolicy Bypass -File setup\start-realworld.ps1" -ForegroundColor Green
