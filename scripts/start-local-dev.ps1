param(
  [switch]$SkipApi,
  [switch]$SkipWeb
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$apiScript = Join-Path $repoRoot 'apps/api'
$webScript = Join-Path $repoRoot 'apps/web'

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
  # Must match apps/web/vite.config.ts and the port the desktop shell waits on
  # (apps/desktop/src/main.ts reads ASCEND_WEB_PORT, defaulting to 5173). This
  # script used to force 4173, so starting everything with dev:all and then
  # launching the desktop shell left it waiting on an empty port and falling
  # back to the placeholder window.
  $webPort = if ($env:ASCEND_WEB_PORT) { [int]$env:ASCEND_WEB_PORT } else { 5173 }
  Start-DetachedProcess -Name 'ascend-web' -WorkingDirectory $webScript -Arguments @('npm.cmd','run','dev','--','--host','127.0.0.1','--strictPort','--port',"$webPort")
}

Write-Host 'Started local services.'
Write-Host "Web: http://127.0.0.1:$webPort/"
Write-Host 'API: http://127.0.0.1:4000/health'
