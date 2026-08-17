@echo off
setlocal

REM Opens Ascend AI. Launch-AscendAI.vbs runs this with no visible window.
REM
REM This script does not start the API or the web client. The desktop shell
REM already does that in ensureSelfHostedServices, with port checks, a health
REM check and a 45s warm-up allowance. Starting them here as well raced it: the
REM previous version spawned run-web-dev.ps1, slept a fixed 8 seconds, and then
REM detached Electron with `start` — after which the shell would exit, the web
REM server sat as a PowerShell process with no vite behind it, and neither port
REM was listening. Electron is now run attached, so this hidden window is its
REM parent and lives exactly as long as the app.

cd /d "%~dp0"

set "LOG=%~dp0launch.log"
echo [%date% %time%] launch requested> "%LOG%"

REM Stop a previous instance of this app only. The command line match keeps it
REM from touching any other Electron app the user happens to be running.
if /i not "%ASCEND_SKIP_PRELAUNCH_KILL%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { (($_.Name -eq 'Ascend AI Desktop.exe') -or ($_.Name -eq 'electron.exe')) -and $_.CommandLine -match 'trhai|Ascend AI Desktop' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >>"%LOG%" 2>&1
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

REM Build output goes to the log rather than nul. A failed build used to be
REM invisible, and the app would then open on whatever was built last.
echo [%time%] building web>> "%LOG%"
call npm run build --workspace @ascend/web >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [%time%] ERROR: web build failed - see above>> "%LOG%"
  goto :fail
)

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
call "%~dp0apps\desktop\node_modules\.bin\electron.cmd" "%~dp0apps\desktop\dist\main.js" >>"%LOG%" 2>&1
echo [%time%] desktop shell exited with code %errorlevel%>> "%LOG%"
endlocal
exit /b 0

:fail
REM Nothing can be printed to a hidden window, so the log is the only channel.
powershell -NoProfile -ExecutionPolicy Bypass -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show('Ascend AI could not start. See launch.log in the app folder.', 'Ascend AI')" >nul 2>&1
endlocal
exit /b 1
