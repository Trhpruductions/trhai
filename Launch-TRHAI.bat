@echo off
REM Opens TRHAI. The work is in scripts\launch-trhai.ps1 — see the comment at
REM the top of that file for why it is PowerShell rather than batch.
REM
REM This wrapper exists so the desktop shortcut has something ordinary to point
REM at, and so double-clicking the file in Explorer works the same way.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-trhai.ps1" %*
exit /b %errorlevel%
