# Changelog

## Unreleased

### Added
- Xtream Codes: movies, series (episodes load when a show is opened) and
  the provider's programme guide are imported, not just live channels.
- Search (Ctrl+K) covers the whole library — channels, movies and series —
  with keyboard navigation.
- Guide matching by channel name for playlists without `tvg-id`, and
  case-insensitive guide ids.
- Playlists' `url-tvg` guides, and Xtream `get.php` playlists' guides, are
  downloaded automatically in the background.
- Per-stream user agent / referrer from `#EXTVLCOPT` and `url|User-Agent=…`.
- Automatic updates with signed packages.
- `F` toggles fullscreen.
- mpv is bundled; no separate install needed.

### Fixed
- Refreshing a playlist no longer wipes favorites and watch history.
- Streams no longer pause themselves while loading.
- Search, settings and dialogs are no longer hidden behind the video.
- The video no longer floats over the guide.
- mpv no longer outlives the app, and restarts itself if it crashes.
- Resume position is saved when switching between titles.

### Security
- Stream URLs from playlists are validated before reaching a player, and
  credentials are redacted from logs and error messages.
- Content Security Policy enabled.
