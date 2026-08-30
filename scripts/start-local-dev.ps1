param(
  [switch]$SkipApi,
  [switch]$SkipWeb
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$apiScript = Join-Path $repoRoot 'apps/api'
# trhai-web, not apps/web: the desktop shell loads TRHAI, so starting the older
# Vite client here leaves the shell waiting on a port nothing serves.
$webScript = Join-Path $repoRoot 'apps/trhai-web'

function Start-DetachedProcess {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string[]]$Arguments
  )

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'cmd.exe'
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.Arguments = '/d /s /c "' + ($Arguments -join ' ') + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  $process.Id | Out-Null
}

if (-not $SkipApi) {
  Start-DetachedProcess -Name 'ascend-api' -WorkingDirectory $apiScript -Arguments @('npm.cmd','run','dev')
}

if (-not $SkipWeb) {
  # Must match the port the desktop shell waits on (apps/desktop/src/main.ts
  # reads ASCEND_WEB_PORT, defaulting to 3210). This script forced 4173 once and
  # 5173 later, and both times starting everything with dev:all and then
  # launching the desktop shell left it waiting on an empty port and falling
  # back to the placeholder window - the failure this comment has described
  # through two different wrong values.
  $webPort = if ($env:ASCEND_WEB_PORT) { [int]$env:ASCEND_WEB_PORT } else { 3210 }
  # Next's flags: -H host, -p port.
  Start-DetachedProcess -Name 'ascend-web' -WorkingDirectory $webScript -Arguments @('npm.cmd','run','dev','--','-H','127.0.0.1','-p',"$webPort")
}

Write-Host 'Started local services.'
Write-Host "Web: http://127.0.0.1:$webPort/"
Write-Host 'API: http://127.0.0.1:4000/health'
