# Tenvy – IPTV Player for Windows

Lightweight Windows IPTV player — Tauri 2 + React + TypeScript. TiviMate-style
grid EPG, M3U / Xtream Codes / XMLTV sources, and embedded mpv for playback so
every codec (HEVC, AC-3, DTS, PGS subs, MKV alternate audio) Just Works.

Tenvy is a player only: it ships no channels or content. Users bring their own
playlist from their own provider.

## Requirements

- **Windows 10/11.** Linux/macOS builds compile but the embedded player is
  Windows-only right now.
- **mpv** is bundled in the installer (`resources/mpv/`). Dev builds without
  it fall back to a system install (Program Files, `%LOCALAPPDATA%\mpv`,
  then `PATH`).

## Dev

```
pnpm install
pnpm tauri dev
```

Set `TENVY_MPV_LOG=1` to make release builds write `%TEMP%\tenvy-mpv.log`
(debug builds always do), and `TENVY_HWDEC=no` to rule out hardware decoding.

### Demo mode (screenshots)

`pnpm dev`, then open `http://localhost:1420/?demo` in a browser: the
backend is replaced by made-up channels, films, series and a guide
(`src/demo/mock.ts`, never part of a build). `&scene=welcome|guide|movies|
series|details|show|live` jumps to a screen; for crisp 2x captures:

```
chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=1440,900 --virtual-time-budget=6000 --screenshot=guide.png "http://localhost:1420/?demo&scene=guide"
```

### Demo video

`scripts/demo-video` records a ~40 s walkthrough of the demo mode (cursor,
captions, title and end cards) with headless Chrome and encodes it with the
bundled mpv. With `pnpm dev` running:

```
node scripts/demo-video/record.mjs
python scripts/demo-video/build.py --encode
```

The storyboard is at the bottom of `record.mjs`; output lands in
`scripts/demo-video/out/`.

## Test

```
cd src-tauri && cargo test --lib
pnpm build        # type-checks the frontend
```

## Build

```
powershell -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1
pnpm tauri build
```

Produces a per-user NSIS installer (no admin prompt) under
`src-tauri/target/release/bundle/nsis/`. The version comes from `package.json`.

## Architecture notes

- `src-tauri/src/mpv/` — subprocess wrapper, JSON IPC over a named pipe, the
  native child-HWND plumbing, and a kill-on-close job object so mpv never
  outlives the app.
- `src-tauri/src/commands/mpv_state.rs` — Tauri command surface; emits
  `mpv://state` on observed-property changes (position throttled to 4 Hz)
  and respawns mpv if it dies.
- `src-tauri/src/sources/` — M3U, Xtream Codes and XMLTV ingest, plus
  `stream_url.rs`, which validates provider URLs before they reach a player
  and redacts credentials from logs.
- `src-tauri/src/db/` — SQLite. Refreshes update channel rows in place
  (keyed on a stable identity) so favorites and watch history survive.
  Xtream series are container rows whose episodes load on demand.
- `src/components/Player/` — geometry-reporting div + docked control strip.
  The video is a native Windows HWND painted on top of WebView2; any UI that
  overlaps it would be invisible, so controls dock below as a sibling and
  the HWND is hidden while a modal is open (`hooks/useVideoObscured.ts`).
