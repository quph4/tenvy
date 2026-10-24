<p align="center">
  <img src="brand/tenvy-icon-512.png" width="96" alt="">
</p>

<h1 align="center">Tenvy</h1>

<p align="center">
  <b>A free, open-source IPTV player for Windows.</b><br>
  Live TV with a real programme guide and catch-up, films and series with artwork —<br>
  for the IPTV service you already have.
</p>

<p align="center">
  <a href="https://apps.microsoft.com/detail/9PMCC6XN52D2?mode=direct"><b>Microsoft Store</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/quph4/tenvy-releases/releases/latest">Installer</a>
  &nbsp;·&nbsp;
  <a href="https://quph4.github.io/tenvy-releases/">Website</a>
  &nbsp;·&nbsp;
  <a href="https://discord.gg/WxShS8pgzR">Discord</a>
</p>

![Tenvy's TV guide](https://quph4.github.io/tenvy-releases/assets/guide.webp)

Tenvy is a player only. It ships no channels, playlists or subscriptions:
you connect a service you already have — an **Xtream Codes** login or an
**M3U** playlist — and should only use it with services you have the right
to watch.

## Features

- **Xtream Codes, M3U/M3U8 and XMLTV**, several providers at once
- **TV guide** with search, reminders, catch-up and start-over
- **Films and series** with posters, resume and next-episode auto-play
- **Watch like TV**: channel numbers and zapping from the keyboard, a mini
  player that stays on top, fullscreen
- **Reconnects by itself** when a stream drops, with clear errors for an
  expired subscription or connections in use
- Audio and subtitle tracks, picture shape, sleep timer
- Favorites, hidden channels and categories, **parental PIN** and lock by
  keyword
- Backup and restore, daily background refresh
- Signed self-updates (or updates through the Microsoft Store)
- **No ads, no account, no telemetry.** Your logins stay on your PC.

| Library | Series |
| --- | --- |
| ![Films](https://quph4.github.io/tenvy-releases/assets/movies.webp) | ![A series](https://quph4.github.io/tenvy-releases/assets/show.webp) |

## How it's built

[Tauri 2](https://tauri.app) (Rust) with a React + TypeScript + Tailwind
interface. Playback is [mpv](https://mpv.io), run as a separate process and
embedded as a native child window, so every codec (HEVC, AC-3, DTS, PGS
subtitles, MKV audio tracks) just works. Data lives in SQLite.

- `src-tauri/src/mpv/` — mpv subprocess, JSON IPC over a named pipe, the
  native child-window plumbing, and a kill-on-close job object so mpv
  never outlives the app.
- `src-tauri/src/commands/` — the Tauri command surface. `mpv_state.rs`
  emits `mpv://state` on observed-property changes, cancels superseded
  loads and respawns mpv if it dies.
- `src-tauri/src/sources/` — M3U, Xtream Codes and XMLTV import, plus
  `stream_url.rs`, which validates provider URLs before they reach a player
  and redacts credentials from logs.
- `src-tauri/src/db/` — SQLite. Refreshes update rows in place (keyed on a
  stable identity) so favorites and history survive; `backup.rs` moves them
  between installs by that identity.
- `src/components/Player/` — the player. The video is a native window above
  WebView2, so nothing can be drawn over it: controls dock below it, and the
  video hides while a dialog is open (`hooks/useVideoObscured.ts`).
  `PlaybackHost.tsx` owns playback whether or not the player is on screen.

## Build from source

Requirements: Windows 10 or 11 (x64), [Node.js](https://nodejs.org) 22,
[pnpm](https://pnpm.io) 10, [Rust](https://rustup.rs) (stable, MSVC) and the
WebView2 runtime (built into Windows 11). The embedded player is
Windows-only; other platforms compile but can't play.

```
pnpm install
pnpm tauri dev
```

Development builds use a system mpv if none is bundled (Program Files,
`%LOCALAPPDATA%\mpv`, then `PATH`). To bundle one, as releases do:

```
powershell -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1                 # copy from a local install
powershell -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1 -Url <7z> -Sha256 <hash>   # a pinned build
```

Releases use a pinned build from
[shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake/releases).
Then `pnpm tauri build` produces a per-user installer (no admin prompt) in
`src-tauri/target/release/bundle/nsis/`.

Set `TENVY_MPV_LOG=1` to make release builds write `%TEMP%\tenvy-mpv.log`
(debug builds always do), and `TENVY_HWDEC=no` to rule out hardware decoding.

### Demo mode (screenshots)

`pnpm dev`, then open `http://localhost:1420/?demo` in a browser: the
backend is replaced by made-up channels, films, series and a guide
(`src/demo/mock.ts`, never part of a build). `&scene=welcome|home|guide|movies|
series|details|show|live|categories|update` jumps to a screen; for crisp 2x captures:

```
chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=1440,900 --virtual-time-budget=6000 --screenshot=guide.png "http://localhost:1420/?demo&scene=guide"
```

### Test provider (real playback without a subscription)

`pnpm test-provider` starts a fake Xtream Codes server on
`http://127.0.0.1:8788` (username `test`, password `test`): live channels
paced like real TV, a guide with catch-up, films, series and account
details. Its video is a test card with a seconds counter, generated by mpv
on first run. Failures on demand:
`/__control?drop=1 | stall=1 | fail=3 | down=1 | expired=1 | max=2 | reset=1`
(see `scripts/test-provider/server.mjs`).

Run the app against a separate library so tests never touch your own
(PowerShell):

```
$env:TENVY_DATA_DIR = "$env:TEMP\tenvy-test"; $env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\tenvy-test\webview"; pnpm tauri dev
```

(`TENVY_DATA_DIR` only works in development builds.) Then connect with
`http://127.0.0.1:8788/get.php?username=test&password=test`.

### Tests

```
cd src-tauri && cargo test --lib     # Rust
pnpm build                           # type-checks the frontend
pnpm e2e                             # end-to-end, against the test provider
```

`pnpm e2e` starts the test provider and a development build of Tenvy against
a fresh, separate library (sound forced off), then drives the app through a
few dozen scenarios: first run, live playback and zapping, the guide and
catch-up, reminders, search, resume, series and next episode, several audio
tracks, fast tab switching with slow answers, favorites, hidden and locked
categories, backup, an mpv crash, starting offline, dropped and stalled
streams, and more. After every test it checks that the app still agrees with
itself. `pnpm e2e Guide` runs only matching tests (`"Guide|Film"` for
several); results and screenshots of failures land in `scripts/e2e/out/`.

### Demo video

`scripts/demo-video` records a ~40 s walkthrough of the demo mode with
headless Chrome and encodes it with mpv. With `pnpm dev` running:

```
node scripts/demo-video/record.mjs
python scripts/demo-video/build.py --encode
```

For a vertical 9:16 cut, record with `--vertical` and run `build_vertical.py`.

### Releases

See [RELEASING.md](RELEASING.md): signed releases from CI, the update feed,
the Microsoft Store package (`scripts/build-msix.ps1`) and the website's
remote config.

## Contributing

Bug reports, ideas and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Questions and ideas are easiest on
[Discord](https://discord.gg/WxShS8pgzR). Security issues: see
[SECURITY.md](SECURITY.md).

Tenvy is free. If you enjoy it, you can [support its
development](https://ko-fi.com/tenvy96627) — entirely optional.

## License

Copyright © 2026 QP Software and contributors.

Tenvy is free software: you can redistribute it and/or modify it under the
terms of the [GNU General Public License](LICENSE) as published by the Free
Software Foundation, either version 3 of the License, or (at your option)
any later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE.

The installer also ships mpv and its libraries under their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
