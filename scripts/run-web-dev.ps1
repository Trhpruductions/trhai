param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$webDir = Join-Path $repoRoot 'apps/web'
$targetPort = 4173

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
  npm.cmd run dev -- --host 127.0.0.1 --strictPort --port $targetPort
}
finally {
  Pop-Location
}
