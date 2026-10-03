<#
.SYNOPSIS
  Populate src-tauri/resources/mpv with the mpv build the installer ships.

.DESCRIPTION
  Two modes:
    - Default: copy mpv.exe (and d3dcompiler_43.dll if present) from a local
      install, for building on a dev machine.
    - -Url/-Sha256: download a pinned 7z release (e.g. a shinchiro
      mpv-x86_64-*.7z), verify its hash, and extract. Use this in CI so
      every release ships a known binary. Requires 7z on PATH.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1
  powershell -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1 -From "C:\Program Files\mpv"
  powershell -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1 -Url https://.../mpv-x86_64-20260301.7z -Sha256 ABC...
#>
param(
  [string]$From,
  [string]$Url,
  [string]$Sha256
)
$ErrorActionPreference = 'Stop'
$dest = Join-Path $PSScriptRoot '..\src-tauri\resources\mpv' | Resolve-Path
$files = @('mpv.exe', 'd3dcompiler_43.dll')

if ($Url) {
  if (-not $Sha256) { throw '-Sha256 is required with -Url so releases ship a verified binary.' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("mpv-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    $archive = Join-Path $tmp 'mpv.7z'
    Invoke-WebRequest -Uri $Url -OutFile $archive
    $actual = (Get-FileHash $archive -Algorithm SHA256).Hash
    if ($actual -ne $Sha256.ToUpper()) { throw "SHA256 mismatch: expected $Sha256, got $actual" }
    & 7z x $archive "-o$tmp\x" -y | Out-Null
    if ($LASTEXITCODE) { throw '7z extraction failed' }
    $src = Join-Path $tmp 'x'
    foreach ($f in $files) {
      $p = Get-ChildItem $src -Recurse -Filter $f | Select-Object -First 1
      if ($p) { Copy-Item $p.FullName $dest -Force }
    }
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
} else {
  if (-not $From) {
    $From = @('C:\Program Files\MPV Player', 'C:\Program Files\mpv') |
      Where-Object { Test-Path (Join-Path $_ 'mpv.exe') } | Select-Object -First 1
  }
  if (-not $From) { throw 'No local mpv install found; pass -From or -Url.' }
  foreach ($f in $files) {
    $p = Join-Path $From $f
    if (Test-Path $p) { Copy-Item $p $dest -Force }
  }
}

if (-not (Test-Path (Join-Path $dest 'mpv.exe'))) { throw 'mpv.exe was not placed in resources/mpv' }
& (Join-Path $dest 'mpv.exe') --version | Select-Object -First 1
Write-Host "mpv ready in $dest"
