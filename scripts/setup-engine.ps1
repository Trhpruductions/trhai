# Installs the model engine TRH AI runs its models with: llama.cpp's server, as
# released at github.com/ggml-org/llama.cpp, into TRH AI's runtime folder.
#
#   npm run setup:engine                    the pinned build, for an NVIDIA card
#   npm run setup:engine -- -Variant cpu    for a PC with no graphics card
#
# It downloads the release's own archives, checks each against the SHA-256 the
# release publishes for it (and, for the default build, the one recorded here),
# and unpacks them to <runtime>\engine\<build>. Nothing is installed
# system-wide and nothing else is changed. Models are separate: put a .gguf
# file in <runtime>\models.
param(
    [string]$Build = "b11366",
    [ValidateSet("cuda-13.4", "cuda-12.4", "vulkan", "cpu")]
    [string]$Variant = "cuda-13.4",
    [string]$RuntimeDir = $(if ($env:TRHAI_RUNTIME_DIR) { $env:TRHAI_RUNTIME_DIR } else { Join-Path $env:LOCALAPPDATA "TRHAI\runtime" })
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# The archives of the build this app was measured with, and their SHA-256.
$known = @{
    "llama-b11366-bin-win-cuda-13.4-x64.zip"  = "894ad612d38db998c185e36665fc0945e1b17321af807f874ae334ea37e1c809"
    "cudart-llama-bin-win-cuda-13.4-x64.zip" = "738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668"
}

$names = @("llama-$Build-bin-win-$Variant-x64.zip")
# A CUDA build needs NVIDIA's runtime libraries beside it. They ship as a second archive.
if ($Variant -like "cuda-*") { $names += "cudart-llama-bin-win-$Variant-x64.zip" }

$target = Join-Path $RuntimeDir "engine\$Build"
if (Test-Path (Join-Path $target "llama-server.exe")) {
    Write-Host "llama.cpp $Build is already installed in $target"
    exit 0
}

Write-Host "Reading the $Build release from github.com/ggml-org/llama.cpp ..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Build" -Headers @{ "User-Agent" = "trhai-setup" }

$downloads = Join-Path $RuntimeDir "downloads"
New-Item -ItemType Directory -Force $downloads, $target | Out-Null

foreach ($name in $names) {
    $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $asset) { throw "The $Build release has no file called $name." }

    $published = "$($asset.digest)" -replace '^sha256:', ''
    if ($known.ContainsKey($name) -and $published -and $published -ne $known[$name]) {
        throw "${name}: the release now publishes a different SHA-256 from the one recorded in this script. It was not installed."
    }
    $expected = if ($known.ContainsKey($name)) { $known[$name] } else { $published }
    if (-not $expected) { throw "${name} has no published SHA-256 to check it against. It was not installed." }

    $file = Join-Path $downloads $name
    Write-Host ("Downloading {0} ({1:N0} MB) ..." -f $name, ($asset.size / 1MB))
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        throw "${name} did not match its SHA-256 (expected $expected, got $actual). It was not installed; the download is left at $file."
    }
    Expand-Archive -Path $file -DestinationPath $target -Force
}

if (-not (Test-Path (Join-Path $target "llama-server.exe"))) {
    throw "The archives unpacked, but there is no llama-server.exe in $target."
}
Write-Host "Installed llama.cpp $Build ($Variant) in $target"
Write-Host "Models go in $(Join-Path $RuntimeDir 'models') - any .gguf file. Start TRH AI again to use them."
