param(
  [string]$WebBaseUrl = 'http://127.0.0.1:4173',
  [string]$ApiBaseUrl = 'http://127.0.0.1:4000'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$slug = "smoke-$timestamp"
$scaffoldPath = "generated-projects/$slug"
$scaffoldFile = 'SMOKE.md'
$scaffoldFullPath = Join-Path $repoRoot "$scaffoldPath\$scaffoldFile"

Write-Host "[smoke] Checking web root: $WebBaseUrl"
$webResponse = Invoke-WebRequest -Uri $WebBaseUrl -Method Get -TimeoutSec 10
if ($webResponse.StatusCode -lt 200 -or $webResponse.StatusCode -ge 300) {
  throw "Web root check failed with status $($webResponse.StatusCode)"
}

Write-Host "[smoke] Checking API health: $ApiBaseUrl/health"
$health = Invoke-RestMethod -Uri "$ApiBaseUrl/health" -Method Get -TimeoutSec 10
if ($health.status -ne 'ok') {
  throw "API health check failed: unexpected status '$($health.status)'"
}

Write-Host "[smoke] Checking assistant API mode flow"
$assistBody = @{ mode = 'build'; message = 'Smoke validate full stack behavior' } | ConvertTo-Json
$assist = Invoke-RestMethod -Uri "$ApiBaseUrl/v1/assist" -Method Post -ContentType 'application/json' -Body $assistBody -TimeoutSec 15
if (-not $assist.data -or [string]::IsNullOrWhiteSpace($assist.data.assistantMessage)) {
  throw 'Assistant API returned empty response'
}

Write-Host "[smoke] Checking scaffold writer endpoint"
$scaffoldBody = @{
  request = 'Smoke scaffold generation'
  spec = @{
    kind = 'file'
    path = $scaffoldPath
    fileName = $scaffoldFile
    content = "# Smoke Test`nGenerated at $timestamp`n"
  }
} | ConvertTo-Json -Depth 6

$scaffold = Invoke-RestMethod -Uri "$WebBaseUrl/__ascend/scaffold" -Method Post -ContentType 'application/json' -Body $scaffoldBody -TimeoutSec 15
if (-not $scaffold.ok) {
  throw "Scaffold writer failed: $($scaffold.error)"
}

if (-not (Test-Path $scaffoldFullPath)) {
  throw "Scaffold file missing on disk: $scaffoldFullPath"
}

Write-Host "[smoke] PASS"
Write-Host "[smoke] Web: OK"
Write-Host "[smoke] API: OK"
Write-Host "[smoke] Assist: OK"
Write-Host "[smoke] Scaffold file: $scaffoldFullPath"