# Releasing

Lumen ships as a per-user NSIS installer (no admin prompt) that updates
itself: on launch and every 6 hours the app fetches `latest.json` from the
release host, and if a newer signed build is listed it shows an
"Update to x.y.z" button in the top bar (also under Settings → About).

## One-time setup

1. **Updater signing key.** Generated at `%USERPROFILE%\.tauri\lumen-updater.key`
   (private) and `.key.pub` (public, already in `tauri.conf.json`).
   - Back the private key up somewhere safe (password manager). If it is
     lost, existing installs can never be updated again.
   - Never commit it. To rotate: `pnpm tauri signer generate -w <path>`,
     put the new `.pub` contents in `plugins.updater.pubkey`, and ship one
     release signed with the *old* key that contains the new pubkey.
2. **Release host.** Create the GitHub repository and replace the
   placeholder in `src-tauri/tauri.conf.json`:
   `https://github.com/OWNER/REPO/releases/latest/download/latest.json`.
   The releases must be publicly downloadable — if the code repo stays
   private, publish releases to a separate public repo (set `owner`/`repo`
   on the tauri-action step).
3. **Repository secrets/variables** (Settings → Secrets and variables → Actions):
   - secret `TAURI_SIGNING_PRIVATE_KEY` — contents of `lumen-updater.key`
   - secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — empty unless you set one
   - variable `MPV_URL` — a pinned 64-bit mpv build, e.g. a
     `mpv-x86_64-*.7z` asset from https://github.com/shinchiro/mpv-winbuild-cmake/releases
   - variable `MPV_SHA256` — that file's SHA-256 (`Get-FileHash -Algorithm SHA256`)
4. **Code signing (strongly recommended before marketing).** Unsigned
   installers trigger SmartScreen's "Windows protected your PC". Options:
   an OV/EV certificate, or Microsoft's cloud signing service (Azure
   Artifact Signing). Wire it in with `bundle.windows.signCommand` in
   `tauri.conf.json` (Tauri runs it for every binary it bundles), e.g.
   `"signCommand": "trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1"`,
   and add the signing credentials as secrets.

## Cutting a release

1. Bump `version` in `package.json` (the app, installer and updater all
   read it from there) and `src-tauri/Cargo.toml`.
2. Add an entry to `CHANGELOG.md`.
3. Commit, tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
4. The `release` workflow builds, signs and creates a **draft** release
   with the installer, its `.sig` and `latest.json`.
5. Smoke-test the installer from the draft, then publish the release.
   Installed apps pick it up within 6 hours (or immediately via
   Settings → About → Check for updates).

## Local release build

    powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1

Fetches mpv if missing, signs with your local key, and leaves the
installer and `.sig` in `src-tauri/target/release/bundle/nsis/`.

## Before the first public release

- Decide the final product name: `productName` and `identifier` in
  `tauri.conf.json` decide the install folder, data folder
  (`%APPDATA%\<identifier>`) and what the updater recognises as "this
  app". They must not change after users have installed it.
- Include the mpv license text in the installer (see THIRD_PARTY_NOTICES.md).
