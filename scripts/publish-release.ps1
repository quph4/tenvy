<#
.SYNOPSIS
  Upload a built, signed installer to the public releases repo as a draft.

.DESCRIPTION
  Run after scripts/build-release.ps1 (or the CI build step). Writes the
  latest.json the in-app updater reads — version, notes, the installer's
  minisign signature and its download URL — and creates a GitHub release
  "v<version>" in the releases repo with the installer and latest.json.

  The release is a DRAFT unless -Publish is given: drafts are invisible to
  users and to the updater. Publish it on GitHub (or rerun with -Publish)
  once you've smoke-tested the installer.

  Uses the GitHub CLI; in CI set GH_TOKEN to a token with Contents:
  read & write on the releases repo.

.PARAMETER Repo
  owner/name of the public releases repo.
#>
param(
  [string]$Repo = 'quph4/tenvy-releases',
  [switch]$Publish
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$tag = "v$version"
$bundle = Join-Path $root 'src-tauri\target\release\bundle\nsis'
$installerName = "Tenvy_${version}_x64-setup.exe"
$installer = Join-Path $bundle $installerName
$sig = "$installer.sig"
foreach ($f in @($installer, $sig)) {
  if (-not (Test-Path $f)) { throw "Missing $f — run scripts/build-release.ps1 first." }
}

# Release notes: this version's section of CHANGELOG.md, if there is one.
$notes = ''
$changelog = Get-Content (Join-Path $root 'CHANGELOG.md') -Raw -ErrorAction SilentlyContinue
if ($changelog -and $changelog -match "(?ms)^## \[?$([regex]::Escape($version))\]?.*?$\r?\n(.*?)(?=^## |\z)") {
  $notes = $Matches[1].Trim()
}

$latest = [ordered]@{
  version   = $version
  notes     = $notes
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = (Get-Content $sig -Raw).Trim()
      url       = "https://github.com/$Repo/releases/download/$tag/$installerName"
    }
  }
}
$latestPath = Join-Path $bundle 'latest.json'
# UTF-8 without BOM: the updater parses this as JSON.
[IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

$notesFile = Join-Path $bundle 'release-notes.md'
[IO.File]::WriteAllText($notesFile, ($(if ($notes) { $notes } else { "Tenvy $tag" })), (New-Object Text.UTF8Encoding $false))

$ghArgs = @('release', 'create', $tag, $installer, $latestPath,
  '--repo', $Repo, '--title', "Tenvy $tag", '--notes-file', $notesFile)
if (-not $Publish) { $ghArgs += '--draft' }
gh @ghArgs
if ($LASTEXITCODE) { throw 'gh release create failed' }
Write-Host ("{0} {1} in {2}" -f $(if ($Publish) { 'Published' } else { 'Drafted' }), $tag, $Repo)
