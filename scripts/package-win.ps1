# Builds the Windows installer: release\TRH-AI-Setup-<version>.exe and a
# portable TRH-AI-Portable-<version>.exe, under apps\desktop\release.
#
# What goes in: the desktop shell, the API as one bundled file, and the web
# app's standalone build. What stays out: the model engine and the models
# (14 GB on a working install) - the app sets those up on first run under
# %LOCALAPPDATA%\TRHAI, as it always has. See docs\23-install-story.md.
#
# npm run package:win

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step([string]$name, [scriptblock]$body) {
    Write-Host ""
    Write-Host "== $name" -ForegroundColor Cyan
    & $body
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "$name failed with exit code $LASTEXITCODE" }
}

Step "shared" { npm run build --workspace @ascend/shared }

Step "web (standalone)" { npm run build --workspace trhai-web }

# Next's standalone output leaves the static files and public/ for the
# packager to place, and the monorepo layout puts the server under
# apps\trhai-web inside it. serve.mjs goes with it so the installed app listens
# on both loopback addresses, as the repo's own `npm run start` does.
Step "web: assemble standalone" {
    $web = Join-Path $root "apps\trhai-web"
    $standalone = Join-Path $web ".next\standalone\apps\trhai-web"
    if (-not (Test-Path (Join-Path $standalone "server.js"))) { throw "no standalone build at $standalone - is next.config.ts output: standalone?" }
    New-Item -ItemType Directory -Force (Join-Path $standalone ".next\static"), (Join-Path $standalone "public"), (Join-Path $standalone "scripts") | Out-Null
    Copy-Item -Recurse -Force (Join-Path $web ".next\static\*") (Join-Path $standalone ".next\static")
    if (Test-Path (Join-Path $web "public")) { Copy-Item -Recurse -Force (Join-Path $web "public\*") (Join-Path $standalone "public") }
    Copy-Item -Force (Join-Path $web "scripts\serve.mjs"), (Join-Path $web "scripts\serve-options.mjs") (Join-Path $standalone "scripts")
    $global:LASTEXITCODE = 0
}

Step "api (bundle)" { npm run bundle --workspace @ascend/api }

Step "desktop" { npm run build --workspace @ascend/desktop }

Step "installer" {
    Set-Location (Join-Path $root "apps\desktop")
    npx electron-builder --win --config electron-builder.json
    Set-Location $root
}

Write-Host ""
Get-ChildItem (Join-Path $root "apps\desktop\release") -Filter "*.exe" | ForEach-Object {
    Write-Host ("built {0} ({1:N0} MB)" -f $_.Name, ($_.Length / 1MB))
}
