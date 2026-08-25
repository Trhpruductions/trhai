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

# Ollama, which the assistant answers with.
#
# It installs into the Startup folder rather than as a service, so it is
# usually already running — but if it has been closed, the app would open with
# no model and only a small "none" on the System panel to explain why. Starting
# it here is the difference between the shortcut opening a working assistant
# and opening one that cannot answer.
#
# Found by looking rather than assumed: `ollama` is on PATH, and `ollama serve`
# is the process the API actually talks to on 11434.
function Start-Ollama-IfDown {
    if (Test-Port 11434) {
        Write-Log "ollama already listening on 11434"
        return
    }

    # The tray app, not `ollama serve`.
    #
    # This mattered and was nearly missed. Starting `ollama serve` directly
    # brought 11434 up and reported llama3.1 and llama3.2 as the installed
    # models — when the models actually installed on this machine are
    # vexora:latest, qwen2.5-coder:7b and qwen2.5:3b. The bare server resolves
    # a different model store from the one the tray app uses, so the launcher
    # would have "recovered" Ollama into a state where the assistant's own
    # model did not exist. Starting it the way Windows does at login is the
    # only version that gives the same machine back.
    $tray = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
    if (Test-Path $tray) {
        Write-Log "starting ollama (tray app)"
        Start-Process -FilePath $tray
        return
    }

    # Fallback for an install without the tray app. Better than nothing, and
    # the model list on the System panel will show what it actually found.
    $ollama = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollama) {
        # Not an error to stop the launch for. The app runs without it and says
        # plainly that no model is loaded, which is more useful than refusing
        # to open at all.
        Write-Log "ollama is not installed; the app will open without a model"
        return
    }

    Write-Log "starting ollama (serve)"
    Start-Process -FilePath $ollama.Source -ArgumentList "serve" -WindowStyle Hidden
}

Start-Ollama-IfDown
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

# Reported separately, and not as failures. The app serves pages without the
# API, and answers without Ollama only to say it cannot — in both cases it
# shows the gap plainly on screen, so opening it is still the right move.
# Saying so here means you know before you look.
if (-not (Test-Port 4000)) {
    Write-Log "app is up but the API is not answering on 4000"
    Write-Host "The app started, but the local API is not answering."
    Write-Host "TRHAI will open and show that plainly. See $log."
}

if (-not (Test-Port 11434)) {
    Write-Log "app is up but ollama is not answering on 11434"
    Write-Host "The app started, but Ollama is not running, so TRHAI cannot generate replies."
    Write-Host "Everything else works: files, schedules, memory and the machine readings."
}

Write-Log "opening"
if (-not $NoOpen) { Start-Process "http://localhost:3210" }
exit 0
