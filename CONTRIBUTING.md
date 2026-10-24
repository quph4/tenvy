# Contributing to Tenvy

Thanks for helping! Tenvy is small and moves quickly, so a few notes make
everyone's life easier.

## Before you start

- **Bugs:** open an issue with the bug template. Include your Tenvy version
  (bottom-right corner) and, if you can, *Settings → About → Copy
  diagnostics* — logins and addresses are removed from it automatically.
  **Never post your provider's address, username or password.**
- **Ideas:** open an issue, or talk it through on
  [Discord](https://discord.gg/WxShS8pgzR) first — especially for bigger
  changes, so you don't build something that doesn't fit.

## Ground rules

- **No content.** Tenvy is a player. Pull requests that add, bundle, link to
  or recommend channels, playlists or providers won't be merged.
- **No telemetry.** Tenvy talks only to the user's own provider and to its
  website (updates and settings). Keep it that way.
- **Privacy in logs.** Provider URLs carry credentials; log them through
  `sources::stream_url::redact`.
- **Never test against a real provider in automated tests.** Use the local
  test provider (`pnpm test-provider`); many subscriptions allow only one
  stream at a time.

## Making a change

1. Fork, then branch from `main`.
2. Follow the code around you: naming, comment style (comments say *why*),
   no new dependencies without a good reason.
3. Check your change:
   ```
   cd src-tauri && cargo test --lib
   pnpm build
   pnpm e2e        # for anything that changes behaviour in the app
   ```
   A bug fix should come with a test that fails without it — a Rust unit
   test, or an end-to-end scenario in `scripts/e2e/tests.mjs`.
4. Add a line under *Unreleased* in `CHANGELOG.md` for anything users notice,
   written for users ("Stop now stops the film" rather than "fix store
   method").
5. Open a pull request describing what changed and how you tested it.

The README explains the architecture and the development tools (demo mode,
test provider, end-to-end tests).

## License

By contributing, you agree that your contributions are licensed under the
GNU General Public License v3.0 or later, like the rest of Tenvy.
