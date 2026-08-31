@echo off
setlocal

REM Opens Vexora AI. Launch-Vexora.vbs runs this with no visible window.
REM
REM This script does not start the API or the web client. The desktop shell
REM already does that in ensureSelfHostedServices, with port checks, a health
REM check and a 45s warm-up allowance. Starting them here as well raced it: the
REM previous version spawned run-web-dev.ps1, slept a fixed 8 seconds, and then
REM detached Electron with `start` ??? after which the shell would exit, the web
REM server sat as a PowerShell process with no vite behind it, and neither port
REM was listening. Electron is now run attached, so this hidden window is its
REM parent and lives exactly as long as the app.

cd /d "%~dp0"

REM The log lives outside the repo. Kept beside the app it was held open by a
REM stale handle from a previous run, and because every step redirects into it,
REM a lock on the log stopped the app from starting at all. A log must never be
REM able to do that, so a failure to write one is also survivable below.
set "LOGDIR=%LOCALAPPDATA%\Vexora"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LOG=%LOGDIR%\launch.log"
REM `||` not errorlevel: a failed redirection does not set errorlevel, so the
REM earlier check never fired and a locked log still killed the launch.
(echo [%date% %time%] launch requested)> "%LOG%" 2>nul || set "LOG=%TEMP%\vexora-launch.log"
(echo [%date% %time%] launch requested)> "%LOG%" 2>nul || set "LOG=nul"

REM Stop a previous instance of this app only. The command line match keeps it
REM from touching any other Electron app the user happens to be running.
if /i not "%ASCEND_SKIP_PRELAUNCH_KILL%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { (($_.Name -eq 'Vexora AI Desktop.exe') -or ($_.Name -eq 'electron.exe')) -and $_.CommandLine -match 'trhai|Vexora AI Desktop' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >>"%LOG%" 2>&1
)

if not exist ".env" (
  if exist ".env.example" copy ".env.example" ".env" >>"%LOG%" 2>&1
)

REM Runs with no database by default; Postgres is opt-in.
findstr /i /c:"API_STORAGE_BACKEND=" ".env" >nul 2>&1
if errorlevel 1 echo API_STORAGE_BACKEND=memory>>".env"

if not exist "node_modules" (
  echo [%time%] installing dependencies>> "%LOG%"
  call npm install >>"%LOG%" 2>&1
)

REM No web build here.
REM
REM This used to build @ascend/web and abort the launch if that failed - the
REM older Vite client, which this app no longer loads. It was building one app
REM and opening another, and a broken build of the dead one stopped the live
REM one from starting at all.
REM
REM Nothing replaces it: the desktop shell serves TRHAI through `next dev`
REM (ensureSelfHostedServices -> dev:web -> scripts/run-web-dev.ps1), which
REM compiles on demand, so a production build would be output nothing reads. A
REM web client that genuinely fails to come up is reported by the shell's own
REM port wait rather than by a build gate here.

echo [%time%] building desktop>> "%LOG%"
call npm run build --workspace @ascend/desktop >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [%time%] ERROR: desktop build failed - see above>> "%LOG%"
  goto :fail
)

if not exist "apps\desktop\dist\main.js" (
  echo [%time%] ERROR: apps\desktop\dist\main.js missing after build>> "%LOG%"
  goto :fail
)

echo [%time%] starting desktop shell>> "%LOG%"
REM Read by the build-info IPC handler, so About can say how the running
REM window was actually started rather than just that it was.
set "ASCEND_LAUNCHED_VIA=Launch-Vexora.bat"
REM Electron output is not redirected into the log: doing so held the file open
REM for as long as the app ran, so a second launch could not write it at all.
call "%~dp0apps\desktop\node_modules\.bin\electron.cmd" "%~dp0apps\desktop\dist\main.js" >nul 2>&1
echo [%time%] desktop shell exited with code %errorlevel%>> "%LOG%"
endlocal
exit /b 0

:fail
REM Nothing can be printed to a hidden window, so the log is the only channel.
powershell -NoProfile -ExecutionPolicy Bypass -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show('Vexora AI could not start. See %LOCALAPPDATA%\Vexora\launch.log.', 'Vexora AI')" >nul 2>&1
endlocal
exit /b 1
