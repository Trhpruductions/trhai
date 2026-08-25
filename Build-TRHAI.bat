@echo off
setlocal

REM Builds TRHAI for launching from the desktop shortcut.
REM
REM Run this once, and again after changing the code. Launch-TRHAI.bat uses
REM what this produces and refuses to start without it — a shortcut that opened
REM a browser onto a connection error would be worse than one that says plainly
REM that the build is missing.

cd /d "%~dp0"

echo Building TRHAI. This takes a minute or two.
echo.

call npm run build --workspace @ascend/shared
if errorlevel 1 goto failed

call npm run build --workspace trhai-web
if errorlevel 1 goto failed

echo.
echo Done. Use the TRHAI shortcut on your desktop to open it.
echo.
pause
exit /b 0

:failed
echo.
echo The build failed. Nothing was installed, and the existing build (if any)
echo is untouched, so the shortcut will still open the previous version.
echo.
pause
exit /b 1
