@echo off
setlocal

cd /d "%~dp0"

if /i not "%ASCEND_SKIP_PRELAUNCH_KILL%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { (($_.Name -eq 'Ascend AI Desktop.exe') -or ($_.Name -eq 'electron.exe')) -and $_.CommandLine -match 'd:\\trhai|Ascend AI Desktop' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
)

findstr /i /c:"API_STORAGE_BACKEND=" ".env" >nul
if errorlevel 1 (
  echo API_STORAGE_BACKEND=memory>>".env"
)

if not exist "node_modules" (
  call npm install
)

pushd "%~dp0"
call npm run build --workspace @ascend/web >nul 2>&1
call npm run build --workspace @ascend/desktop >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command "$webProcess = Get-CimInstance Win32_Process -Filter \"Name = 'powershell.exe' AND CommandLine LIKE '%%run-web-dev.ps1%%'\" -ErrorAction SilentlyContinue; if (-not $webProcess) { Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','./scripts/run-web-dev.ps1' -WorkingDirectory '%~dp0' -WindowStyle Hidden }" >nul 2>&1

timeout /t 8 /nobreak >nul
start "" "%~dp0apps\desktop\node_modules\.bin\electron.cmd" "%~dp0apps\desktop\dist\main.js"
popd

endlocal
