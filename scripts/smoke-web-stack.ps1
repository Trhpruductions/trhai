param(
  # 3210 is TRHAI. This defaulted to 4173, the old Vite preview port, so a smoke
  # run with no arguments checked a server that is no longer part of the app.
  [string]$WebBaseUrl = 'http://127.0.0.1:3210',
  [string]$ApiBaseUrl = 'http://127.0.0.1:4000'
)

$ErrorActionPreference = 'Stop'

Write-Host "[smoke] Checking web root: $WebBaseUrl"
# 60s, not 10: under `npm run dev:all` the first request compiles the page,
# measured at 26 seconds; every request after it answers in a tenth of one.
$webResponse = Invoke-WebRequest -Uri $WebBaseUrl -Method Get -TimeoutSec 60 -UseBasicParsing
if ($webResponse.StatusCode -lt 200 -or $webResponse.StatusCode -ge 300) {
  throw "Web root check failed with status $($webResponse.StatusCode)"
}

Write-Host "[smoke] Checking API health: $ApiBaseUrl/health"
$health = Invoke-RestMethod -Uri "$ApiBaseUrl/health" -Method Get -TimeoutSec 10
if ($health.status -ne 'ok') {
  throw "API health check failed: unexpected status '$($health.status)'"
}

# A request the app answers itself, not the model. This used to send "Smoke
# validate full stack behavior" in build mode, which reached the model with
# every tool in reach - a smoke check that could build an app or run a command
# on the machine it was checking, and that failed whenever the model took
# longer than the 15 seconds it was given.
Write-Host "[smoke] Checking the assistant answers"
$assistBody = @{ mode = 'general'; message = 'what can you do?' } | ConvertTo-Json
$assist = Invoke-RestMethod -Uri "$ApiBaseUrl/v1/assist" -Method Post -ContentType 'application/json' -Body $assistBody -TimeoutSec 15
if (-not $assist.data -or [string]::IsNullOrWhiteSpace($assist.data.assistantMessage)) {
  throw 'Assistant API returned empty response'
}

# The scaffold writer this script used to post to, /__ascend/scaffold, was a
# dev-server route of the old Vite client and does not exist in TRHAI, so the
# script could never pass. What it stood for - that the app can reach the
# machine it runs on - is checked here through the routes the interface uses.
Write-Host "[smoke] Checking the tools and the machine readings"
$capabilities = Invoke-RestMethod -Uri "$ApiBaseUrl/v1/capabilities" -Method Get -TimeoutSec 10
if (-not $capabilities.data.tools -or $capabilities.data.tools.Count -eq 0) {
  throw 'The API reported no tools'
}
$telemetry = Invoke-RestMethod -Uri "$ApiBaseUrl/v1/system-telemetry" -Method Get -TimeoutSec 15
if (-not $telemetry.data.cpu -or -not $telemetry.data.memory) {
  throw 'The API returned no machine readings'
}

Write-Host "[smoke] PASS"
Write-Host "[smoke] Web: OK"
Write-Host "[smoke] API: OK"
Write-Host "[smoke] Assist: OK ($($assist.data.strategy))"
Write-Host "[smoke] Tools: $($capabilities.data.tools.Count)"
Write-Host "[smoke] Machine readings: OK"
