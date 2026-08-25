# Starts TRHAI and opens it.
#
# Two processes: the local API on 4000 and the app on 3210. Both are started
# here rather than by the app itself, because the app is a web page and a web
# page cannot start its own backend.
#
# This is PowerShell rather than a .bat because the batch version kept failing
# in ways that were hard to see. Its port check parsed Test-NetConnection's
# stdout and compared the text to "True", which silently decided the API port
# was taken and skipped starting it; the rewrite using exit codes then stopped
# after the first service with nothing in the log to say why — nested quoting
# through `start "" cmd /c "... >> ""%LOG%"" 2>&1"` is a poor place to spend
# debugging time. Here the same work is a few readable lines.

param(
    # Skips opening a browser. Used by the smoke check, which cares whether the
    # services came up, not whether a window appeared.
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# The log lives outside the repo, and failing to write one must never stop the
# app starting. That is the lesson Launch-Vexora.bat records: kept beside the
# app, a stale handle on the log blocked the launch itself.
$logDir = Join-Path $env:LOCALAPPDATA "TRHAI"
try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null } catch {}
$log = Join-Path $logDir "launch.log"

function Write-Log([string]$message) {
    try { Add-Content -Path $log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $message" } catch {}
}

function Test-Port([int]$port) {
    return Test-NetConnection -ComputerName localhost -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
}

# Refuse to start on a build that does not exist, rather than opening a browser
# onto a connection error. Naming the command to run beats a blank tab.
if (-not (Test-Path (Join-Path $root "apps\trhai-web\.next"))) {
    Write-Host "TRHAI has not been built yet."
    Write-Host ""
    Write-Host "Run Build-TRHAI.bat once, then use this shortcut."
    Write-Log "refused: no build"
    if (-not $NoOpen) { Read-Host "Press Enter to close" }
    exit 1
}

Write-Log "launch requested"

# Started only when the port is free, so launching twice opens the app you have
# rather than racing a second copy onto a taken port.
function Start-Service-IfDown([int]$port, [string]$name, [string]$argumentList) {
    if (Test-Port $port) {
        Write-Log "$name already listening on $port"
        return
    }
    Write-Log "starting $name on $port"
    # Working directory is the repo root so npm resolves the workspace.
    Start-Process -FilePath "npm.cmd" -ArgumentList $argumentList `
        -WorkingDirectory $root -WindowStyle Hidden
}

Start-Service-IfDown 4000 "API" "run start --workspace @ascend/api"
Start-Service-IfDown 3210 "app" "run start --workspace trhai-web -- -p 3210"

# Wait for the app to actually answer before opening a window at it. A fixed
# sleep is the wrong tool: too short on a cold start, wasted on a warm one.
Write-Host "Starting TRHAI..."
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:3210" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}

if (-not $ready) {
    Write-Log "app did not answer within 90s"
    Write-Host "TRHAI did not start within 90 seconds."
    Write-Host "See $log for what happened."
    if (-not $NoOpen) { Read-Host "Press Enter to close" }
    exit 1
}

# Reported separately: the app can serve pages while the API is down, and it
# says so on screen rather than looking broken. Worth knowing at launch too.
if (-not (Test-Port 4000)) {
    Write-Log "app is up but the API is not answering on 4000"
    Write-Host "The app started, but the local API is not answering."
    Write-Host "TRHAI will open and show that plainly. See $log."
}

Write-Log "opening"
if (-not $NoOpen) { Start-Process "http://localhost:3210" }
exit 0
