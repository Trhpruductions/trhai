# Starts TRH World and opens its window.
#
# TRH World is its own app. It does not start TRH AI and does not need it to be
# running to open: with TRH AI off, its window says so and shows the empty town.
#
# Two things: the World server on 3333 (only if that port is free, so launching
# twice opens the window you have rather than racing a second server onto the
# port), and a window for it. The window is Electron from the desktop app's
# install, run with the World's own main.cjs. Without Electron it opens the
# default browser instead.

param(
    # Start the server and stop; do not open a window. For checks.
    [switch]$NoOpen,
    # Open the default browser instead of the desktop window.
    [switch]$Browser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$world = Join-Path $root "apps\world"
$port = 3333

$logDir = Join-Path $env:LOCALAPPDATA "TRHAI"
try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null } catch {}
$log = Join-Path $logDir "world.log"

function Write-Log([string]$message) {
    try { Add-Content -Path $log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $message" } catch {}
}

function Test-Port([int]$p) {
    return Test-NetConnection -ComputerName 127.0.0.1 -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue
}

Write-Log "launch requested"

if (-not (Test-Port $port)) {
    Write-Log "starting the World server on $port"
    $out = Join-Path $logDir "world-server.log"
    $err = Join-Path $logDir "world-server.err.log"
    try {
        Start-Process -FilePath "node.exe" -ArgumentList "server.mjs" -WorkingDirectory $world -WindowStyle Hidden `
            -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
    } catch {
        Write-Log "could not write the server logs ($($_.Exception.Message)); starting without them"
        Start-Process -FilePath "node.exe" -ArgumentList "server.mjs" -WorkingDirectory $world -WindowStyle Hidden
    }
} else {
    Write-Log "the World server is already listening on $port"
}

$deadline = (Get-Date).AddSeconds(20)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 400
}
if (-not $ready) {
    Write-Log "the World server did not answer within 20s"
    Write-Host "TRH World did not start. See $log"
    exit 1
}

Write-Log "server ready"
if ($NoOpen) { exit 0 }

$electron = Join-Path $root "apps\desktop\node_modules\.bin\electron.cmd"
$main = Join-Path $world "main.cjs"

if (-not $Browser -and (Test-Path $electron) -and (Test-Path $main)) {
    # One window: close one that is already open rather than stacking a second.
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*apps\world\main.cjs*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Log "opening the window"
    $env:WORLD_URL = "http://127.0.0.1:$port"
    Start-Process -FilePath $electron -ArgumentList "`"$main`"" -WorkingDirectory $world -WindowStyle Hidden
    exit 0
}

Write-Log "opening the browser"
Start-Process "http://127.0.0.1:$port"
