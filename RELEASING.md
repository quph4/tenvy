# Releasing

Tenvy ships as a per-user NSIS installer (no admin prompt) that updates
itself: on launch and every 6 hours the app fetches
`https://github.com/quph4/tenvy-releases/releases/latest/download/latest.json`,
and if a newer signed build is listed it shows an "Update to x.y.z" button
in the top bar (also under Settings → About).

The code lives in the private repo `quph4/tenvy`; installers and
`latest.json` are published to the public repo `quph4/tenvy-releases`
(GitHub doesn't serve release downloads from private repos anonymously).

## One-time setup

1. **Updater signing key** — `%USERPROFILE%\.tauri\tenvy-updater.key`
   (private) and `.key.pub` (public, already in `tauri.conf.json`).
   - Back the private key up somewhere safe (password manager). If it is
     lost, existing installs can never be updated again.
   - Never commit it. To rotate: `pnpm tauri signer generate -w <path>`,
     put the new `.pub` contents in `plugins.updater.pubkey`, and ship one
     release signed with the *old* key that contains the new pubkey.
2. **Secrets for CI** on `quph4/tenvy` (run from the repo root):

       gh secret set TAURI_SIGNING_PRIVATE_KEY < "$env:USERPROFILE\.tauri\tenvy-updater.key"
       gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""
       gh secret set RELEASES_TOKEN

   `RELEASES_TOKEN` is a fine-grained personal access token
   (github.com → Settings → Developer settings → Fine-grained tokens) with
   access to **only** `quph4/tenvy-releases` and the permission
   **Contents: Read and write**. `gh secret set` prompts for it.
3. **Pinned mpv build** for CI (repo variables):

       gh variable set MPV_URL --body "<https URL of a mpv-x86_64-*.7z>"
       gh variable set MPV_SHA256 --body "<its SHA-256>"

   Pick a release from https://github.com/shinchiro/mpv-winbuild-cmake/releases
   and hash it with `Get-FileHash -Algorithm SHA256`.
4. **Code signing (strongly recommended before marketing).** Unsigned
   installers trigger SmartScreen's "Windows protected your PC". Options:
   an OV/EV certificate, or Microsoft's cloud signing service (Azure
   Artifact Signing). Wire it in with `bundle.windows.signCommand` in
   `tauri.conf.json` (Tauri runs it for every binary it bundles), e.g.
   `"signCommand": "trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1"`,
   and add the signing credentials as secrets.

## Cutting a release

1. Bump `version` in `package.json` (the app, installer and updater read
   it from there) and in `src-tauri/Cargo.toml`.
2. Add a `## <version>` section to `CHANGELOG.md` — it becomes the release
   notes shown in the update prompt.
3. Commit, tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
4. The `release` workflow tests, builds, signs and creates a **draft**
   release `v0.2.0` in `quph4/tenvy-releases` with the installer and
   `latest.json`.
5. Smoke-test the installer from the draft, then publish it
   (`gh release edit v0.2.0 --repo quph4/tenvy-releases --draft=false`).
   Installed apps pick it up within 6 hours, or immediately via
   Settings → About → Check for updates.

## Local release (without CI)

    powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
    powershell -ExecutionPolicy Bypass -File scripts/publish-release.ps1

The first fetches mpv if missing and builds a signed installer; the second
drafts the release in `quph4/tenvy-releases` (add `-Publish` to publish
directly).

## Before the first public release

- `productName` and `identifier` (`app.tenvy.player`) in `tauri.conf.json`
  decide the install folder, the data folder (`%APPDATA%\app.tenvy.player`)
  and what the updater recognises as "this app". Never change them after
  users have installed it.
- Include the mpv license text in the installer (see THIRD_PARTY_NOTICES.md).
- Register the domain (tenvy.app) and check the trademark (EUIPO).
