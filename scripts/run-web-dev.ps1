param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
# trhai-web, not apps/web. The desktop shell loads TRHAI, and this script is
# what the shell runs to bring the web client up; pointing it at the older Vite
# client meant launching the desktop app started the wrong app on the wrong
# port, waited the full 45s for a port nothing was listening on, and then
# showed the placeholder shell. The two ends of the same launch disagreed.
$webDir = Join-Path $repoRoot 'apps/trhai-web'
# Must match the port the desktop shell waits on (ASCEND_WEB_PORT in
# apps/desktop/src/main.ts). When these disagree the desktop window waits
# forever on an empty port and falls back to the placeholder shell, which
# looks like the app failing to start.
$targetPort = if ($env:ASCEND_WEB_PORT) { [int]$env:ASCEND_WEB_PORT } else { 3210 }

function Get-PortListenerPids {
  param(
    [int]$Port
  )

  $result = @()
  $lines = netstat -ano -p tcp
  foreach ($line in $lines) {
    if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      $linePort = [int]$matches[1]
      $linePid = [int]$matches[2]
      if ($linePort -eq $Port) {
        $result += $linePid
      }
    }
  }

  return $result | Select-Object -Unique
}

$listenerPids = Get-PortListenerPids -Port $targetPort
if ($listenerPids.Count -gt 0) {
  $listeners = @()
  foreach ($pidValue in $listenerPids) {
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($null -ne $proc) {
      $listeners += $proc
    }
  }

  if ($listeners.Count -eq 0) {
    throw "Port $targetPort is in use by an unknown process."
  }

  $nonNode = @($listeners | Where-Object { $_.ProcessName -ne 'node' })
  if ($nonNode.Count -gt 0) {
    $names = ($nonNode | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ', '
    throw "Port $targetPort is occupied by non-web process(es): $names"
  }

  $names = ($listeners | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ', '
  Write-Host "Web dev server appears to already be running on port $targetPort ($names)."
  exit 0
}

Push-Location $webDir
try {
  # Next's flags, not Vite's: -p for the port, -H for the host. The old
  # --strictPort has no Next equivalent, but the listener check above already
  # bails when the port is taken, so nothing silently lands on a second port.
  npm.cmd run dev -- -H 127.0.0.1 -p $targetPort
}
finally {
  Pop-Location
}
