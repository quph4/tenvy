<#
.SYNOPSIS
  Build a signed, updater-ready release locally.

.DESCRIPTION
  Makes sure the bundled mpv is present, loads the updater signing key and
  runs `pnpm tauri build`. Output (installer + .sig) lands in
  src-tauri/target/release/bundle/nsis/. CI does the same in
  .github/workflows/release.yml.

.PARAMETER KeyPath
  Updater private key. Defaults to %USERPROFILE%\.tauri\tenvy-updater.key.
#>
param(
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.tauri\tenvy-updater.key')
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

if (-not (Test-Path (Join-Path $root 'src-tauri\resources\mpv\mpv.exe'))) {
  & (Join-Path $PSScriptRoot 'fetch-mpv.ps1')
}
if (-not (Test-Path $KeyPath)) {
  throw "Updater signing key not found at $KeyPath. See RELEASING.md."
}

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $KeyPath -Raw
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '' }

Push-Location $root
try {
  pnpm tauri build
  if ($LASTEXITCODE) { throw 'tauri build failed' }
} finally {
  Pop-Location
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
}
Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis') | Select-Object Name, Length
