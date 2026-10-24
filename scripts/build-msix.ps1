# Builds the Microsoft Store package (MSIX) from a release build.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-msix.ps1 [-SkipBuild]
#
# Output: src-tauri/target/msix/Tenvy_<version>_x64.msix, unsigned - upload
# it in Partner Center, which signs it. The Store version updates through
# the Store; the app notices it runs as a package and never updates itself
# (src-tauri/src/distribution.rs).
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
# The Store wants four parts, the last one 0.
$msixVersion = "$version.0"

$kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
$sdk = Get-ChildItem $kits -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'x64\makeappx.exe') } |
  Sort-Object { [version]$_.Name } | Select-Object -Last 1
if (-not $sdk) { throw 'Windows SDK not found (makeappx.exe). Install the Windows 10/11 SDK.' }
$makeappx = Join-Path $sdk.FullName 'x64\makeappx.exe'
$makepri = Join-Path $sdk.FullName 'x64\makepri.exe'

$release = Join-Path $root 'src-tauri\target\release'
if (-not $SkipBuild) {
  # The build copies resources but never deletes old ones; start the
  # licenses folder clean so a renamed license file can't linger in the package.
  $oldLicenses = Join-Path $release 'licenses'
  if (Test-Path $oldLicenses) { Remove-Item -Recurse -Force $oldLicenses }
  Push-Location $root
  try {
    pnpm tauri build --no-bundle
    if ($LASTEXITCODE) { throw 'tauri build failed' }
  } finally { Pop-Location }
}

$out = Join-Path $root 'src-tauri\target\msix'
$layout = Join-Path $out 'layout'
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
New-Item -ItemType Directory -Force $layout | Out-Null

# The app and the resources tauri.conf.json bundles next to it.
Copy-Item (Join-Path $release 'tenvy.exe') $layout
foreach ($dir in 'mpv', 'licenses') {
  $src = Join-Path $release $dir
  if (-not (Test-Path $src)) { throw "$src is missing - run a release build first." }
  Copy-Item -Recurse $src (Join-Path $layout $dir)
}
Copy-Item -Recurse (Join-Path $PSScriptRoot 'store\Assets') (Join-Path $layout 'Assets')
(Get-Content (Join-Path $PSScriptRoot 'store\AppxManifest.xml') -Raw).Replace('{VERSION}', $msixVersion) |
  Set-Content -Encoding utf8 (Join-Path $layout 'AppxManifest.xml')

# resources.pri lets Windows pick the right icon size (and the ones without
# a coloured backplate on the taskbar).
$priConfig = Join-Path $out 'priconfig.xml'
& $makepri createconfig /cf $priConfig /dq en-US /o | Out-Null
if ($LASTEXITCODE) { throw 'makepri createconfig failed' }
& $makepri new /pr $layout /cf $priConfig /mn (Join-Path $layout 'AppxManifest.xml') /of (Join-Path $layout 'resources.pri') /o | Out-Null
if ($LASTEXITCODE) { throw 'makepri new failed' }

$msix = Join-Path $out "Tenvy_${version}_x64.msix"
& $makeappx pack /d $layout /p $msix /o
if ($LASTEXITCODE) { throw 'makeappx pack failed' }
Write-Host "`nStore package: $msix"
