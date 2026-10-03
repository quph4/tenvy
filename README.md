# Lumen

Lightweight Windows IPTV player — Tauri 2 + React + TypeScript. TiviMate-style
grid EPG, M3U / Xtream / XMLTV sources, and embedded mpv for playback so every
codec (HEVC, AC-3, DTS, PGS subs, MKV alternate audio) Just Works.

## Requirements

- **Windows 10/11.** Linux/macOS builds compile but the embedded player is
  Windows-only right now.
- **mpv.exe on PATH.** Lumen spawns mpv as a child process and parents it
  into a native HWND inside the Tauri window. We look in this order:
    1. `PATH`
    2. `C:\Program Files\mpv\mpv.exe`
    3. `%APPDATA%\mpv\mpv.exe`
  Install from https://mpv.io/installation/ (the
  [shinchiro](https://github.com/shinchiro/mpv-winbuild-cmake) Windows builds
  are recommended) and make sure `mpv --version` runs in a terminal.

## Dev

```
pnpm install
pnpm tauri dev
```

## Build

```
pnpm tauri build
```

Ships an MSI under 15 MB. mpv is **not** bundled — it's a user install.

## Architecture notes

- `src-tauri/src/mpv/` — subprocess wrapper, JSON IPC over a named pipe, and
  the native child-HWND plumbing.
- `src-tauri/src/commands/mpv_state.rs` — Tauri command surface; emits
  `mpv://state` events on every observed-property change.
- `src/components/Player/` — geometry-reporting div + docked control strip.
  The video is a native Windows HWND painted on top of WebView2; any UI that
  overlaps it would be invisible, so controls dock below as a sibling.
