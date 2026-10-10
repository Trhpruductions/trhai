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
    # Skips opening the app. Used by the smoke check, which cares whether the
    # services came up, not whether a window appeared.
    [switch]$NoOpen,

    # Opens in the default browser instead of the desktop window. Kept because
    # the browser is genuinely useful for looking at devtools, and because a
    # broken Electron build should not make the app unreachable.
    [switch]$Browser
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

# The shortcut serves the built output, not the source. A build older than the
# code it was built from opens yesterday's app behind today's icon, which is
# worse than a crash: it looks like the change simply did not work.
#
# Said, never enforced. Rebuilding here would turn a fourteen-second launch
# into a several-minute one, and refusing to open would let a stray keystroke
# in an editor lock you out of your own app.
try {
    $buildStamp = (Get-Item (Join-Path $root "apps/trhai-web/.next/BUILD_ID") -ErrorAction Stop).LastWriteTime
    $newestSource = Get-ChildItem (Join-Path $root "apps/trhai-web/src") -Recurse -File -ErrorAction Stop |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newestSource -and $newestSource.LastWriteTime -gt $buildStamp) {
        Write-Host "Note: the interface has changed since it was last built."
        Write-Host "      Opening the previous build. Run Build-TRHAI.bat for the new one."
        Write-Log "stale build: $($newestSource.Name) is newer than BUILD_ID"
    }
} catch {
    Write-Log "could not compare build age: $($_.Exception.Message)"
}


# Stop a window that is already open rather than stacking a second one on the
# same services. Matched on the command line so this only ever touches this
# app's own shell, never another Electron app that happens to be running.
if (-not $NoOpen -and -not $Browser) {
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*apps\desktop\dist\main.js*" } |
        ForEach-Object {
            Write-Log "closing an already-open window (pid $($_.ProcessId))"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

Write-Log "launch requested"

# Started only when the port is free, so launching twice opens the app you have
# rather than racing a second copy onto a taken port.
function Start-Service-IfDown([int]$port, [string]$name, [string]$argumentList, [string]$logName) {
    if (Test-Port $port) {
        Write-Log "$name already listening on $port"
        return
    }
    Write-Log "starting $name on $port"

    # Keep what the service prints.
    #
    # These are started hidden, so until now every line they wrote was
    # discarded. That silently threw away the app's own diagnostics: the
    # orchestrator logs "[assist] <model> unusable" when a model fails to load
    # and it falls through to a weaker one, and that line exists precisely
    # because a model failing used to be invisible. Launched from the desktop
    # shortcut it was invisible again - not for want of logging, but for want
    # of anywhere to put it.
    #
    # Overwritten per launch rather than appended, because Start-Process cannot
    # append and an ever-growing file nobody rotates is its own problem. The
    # previous run is kept as .prev so a crash is still readable after the
    # restart that follows it.
    $out = Join-Path $logDir "$logName.log"
    $errors = Join-Path $logDir "$logName.err.log"
    foreach ($file in @($out, $errors)) {
        try {
            if (Test-Path $file) { Move-Item -Path $file -Destination "$file.prev" -Force -ErrorAction Stop }
        } catch {
            # Keeping the previous log is a convenience, never a reason to fail.
        }
    }

    # Working directory is the repo root so npm resolves the workspace.
    try {
        Start-Process -FilePath "npm.cmd" -ArgumentList $argumentList `
            -WorkingDirectory $root -WindowStyle Hidden `
            -RedirectStandardOutput $out -RedirectStandardError $errors -ErrorAction Stop
    } catch {
        # A held handle on a log file must never stop the app starting. That is
        # the lesson Launch-Vexora.bat records, and it applies to the log this
        # function just tried to open as much as to the launcher's own.
        Write-Log "could not write $name logs ($($_.Exception.Message)); starting without them"
        Start-Process -FilePath "npm.cmd" -ArgumentList $argumentList `
            -WorkingDirectory $root -WindowStyle Hidden
    }
}

# The model engine is not started here. The API starts it (llama.cpp, from
# %LOCALAPPDATA%\TRHAI\runtime) and stops it when it stops, so there is no
# second application to keep running. `npm run setup:engine` installs it, and
# the System panel says why when it is not there.
Start-Service-IfDown 4000 "API" "run start --workspace @ascend/api" "api"
Start-Service-IfDown 3210 "app" "run start --workspace trhai-web -- -p 3210" "web"

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
# API, and answers without a model only to say it cannot — in both cases it
# shows the gap plainly on screen, so opening it is still the right move.
# Saying so here means you know before you look.
if (-not (Test-Port 4000)) {
    Write-Log "app is up but the API is not answering on 4000"
    Write-Host "The app started, but the local API is not answering."
    Write-Host "TRHAI will open and show that plainly. See $log."
} else {
    # The model, asked of the API rather than guessed from a port: it knows
    # whether the engine is installed, whether it started, and whether it has
    # a model to answer with. The engine starts just after the API does, so it
    # is given a few seconds before anything is said.
    $model = $null
    $until = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $until) {
        try {
            $model = (Invoke-RestMethod -Uri "http://127.0.0.1:4000/v1/assist/model" -TimeoutSec 5).data
            if ($model.available) { break }
        } catch {}
        Start-Sleep -Milliseconds 750
    }
    if (-not $model -or -not $model.available) {
        $why = if ($model -and $model.reason) { $model.reason } else { "The API did not say why." }
        Write-Log "app is up but no model is answering: $why"
        Write-Host "The app started, but no model is answering, so TRHAI cannot generate replies."
        Write-Host $why
        Write-Host "Everything else works: files, schedules, memory and the machine readings."
    }
}

# Warm the model in the background so the first real question is not the one
# that pays for loading it. On a PC with no graphics card that first question
# takes minutes: the model is read off disk and the whole prompt is processed.
# A greeting takes the same front of the prompt as an ordinary question, and
# the engine keeps what it processed, so the questions after it are quick.
# Skipped under -NoOpen, which is the smoke check and wants a quiet machine.
if (-not $NoOpen -and (Test-Port 4000)) {
    try {
        $warm = '{"message":"Hello.","sessionId":"warm-up"}'
        Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
            "-NoProfile", "-Command",
            "try { Invoke-RestMethod -Uri http://127.0.0.1:4000/v1/assist -Method Post -ContentType 'application/json' -Body '$warm' -TimeoutSec 900 | Out-Null } catch {}")
        Write-Log "warming the model"
    } catch {
        Write-Log "could not start the warm-up: $($_.Exception.Message)"
    }
}

Write-Log "opening"
if ($NoOpen) { exit 0 }

if ($Browser) {
    Start-Process "http://localhost:3210"
    exit 0
}

# The desktop window, not a browser tab.
#
# The Electron shell already exists in this repo and knows how to be an app
# window — it just pointed at the older web client on 5173. Two environment
# variables aim it here instead:
#
#   ASCEND_WEB_PORT       load TRHAI on 3210 rather than the old client
#   ASCEND_DISABLE_AUTOSTART  do not start its own services; this script has
#                             already started them, in production mode, and
#                             two things racing for the same ports is how the
#                             old launcher ended up with a web server running
#                             behind no vite at all
$electron = Join-Path $root "apps\desktop\node_modules\.bin\electron.cmd"
$mainJs = Join-Path $root "apps\desktop\dist\main.js"

if ((Test-Path $electron) -and (Test-Path $mainJs)) {
    Write-Log "opening desktop window"
    $env:ASCEND_WEB_PORT = "3210"
    $env:ASCEND_DISABLE_AUTOSTART = "1"
    Start-Process -FilePath $electron -ArgumentList $mainJs -WorkingDirectory $root -WindowStyle Hidden
    exit 0
}

# No desktop build. The app itself is running and reachable, so opening a
# browser is a better outcome than refusing to show it at all — and it says
# which command produces the window.
Write-Log "no desktop build; opening a browser instead"
Write-Host "The desktop window is not built yet, so this opened in your browser."
Write-Host "Run: npm run build --workspace @ascend/desktop"
Start-Process "http://localhost:3210"
exit 0
