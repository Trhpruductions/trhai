# Puts a "TRH World" shortcut on the Desktop that opens the World app.
param([string]$Folder = [Environment]::GetFolderPath("Desktop"))

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root "scripts\launch-world.ps1"
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $Folder "TRH World.lnk"))
$link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$link.WorkingDirectory = $root
$link.Description = "TRH World - the agents' town"
$link.Save()
Write-Host "Shortcut written: $($link.FullName)"
