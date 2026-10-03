# Changelog

## Unreleased

### Added
- Clearer reasons when a channel won't open: an expired subscription, or
  every allowed connection in use, straight from your provider. Reconnect
  attempts are counted on screen (1/5, 2/5…).
- Automatic reconnect: when a stream drops, stalls or ends early, Tenvy
  reopens it (films at the same spot) with growing pauses, and asks
  after five tries in a row.
- Picture & sound panel: picture shape (Auto, 16:9, 4:3, Fill, Stretch —
  also the A key), audio and subtitle delay, speed for films, a sleep
  timer (minutes or "when this programme ends") and stream details
  (also the I key). Audio/subtitle tracks for live channels that have
  several.
- Your own lists: hide single channels, reorder favorites (⋯ menu or
  right-click on a channel), channel numbers in the list. Provider
  section titles like "-= Sweden =-" show as headings and don't count
  as channels.
- Rename a provider in Settings (click its name).
- Home: continue watching, recently watched and favorite channels (with
  what's on), favorite films and series, and the newest movies and
  series — plus your subscription status at a glance.
- Subscription details from your provider: status, expiry date and
  connections in Settings, and a heads-up a week before it runs out.
- Manage categories: hide the ones you never watch (they leave "All",
  search and the sidebar), filter and "show only these" for huge lists.
- Parental lock: lock categories behind a PIN (one click for adult
  categories); locked content stays out of lists, search and playback
  until the PIN is entered.
- TV-style channel switching: type a channel number (0–9), Backspace for
  the previous channel, PgUp/PgDn as well as ↑/↓, and a banner over the
  picture with the channel, what's on now (and how long is left) and next.
- Reminders and other notices now appear over the video in fullscreen;
  press Enter to act on them ("Watch now").
- Tenvy remembers the audio and subtitle language you pick (or that you
  turned subtitles off) and uses it on every channel and film.
- Optional: start with the last channel (Settings → Playback).
- Open-source licenses and the privacy policy are linked from Settings →
  About; license texts are installed with Tenvy.
- Tenvy is free. "Support Tenvy" (footer and Settings → About) and an
  occasional, gentle prompt once you've used it for a while; both, and
  short announcements, are controlled from the website without an update.
- Reminders: "Remind me" on upcoming programmes in the guide (and on
  what's next under the player); a Windows notification and a "Watch now"
  prompt just before it starts. Programme cards in the guide.
- New first-run page: connect your provider inline (paste a full Xtream
  link to fill in all fields), then see what was imported.
- Movie and series library: poster grid with ratings and progress,
  details pages (plot, cast, trailer, resume), seasons and episodes with
  "Continue", and a full-width player.
- Champagne-on-graphite look and a new app icon.
- Catch-up: watch programmes that already aired from the guide (on
  channels your provider archives), and "Start over" on what's on now.
- Guide paging a week back and forward.
- Mini player (P): a small always-on-top window in the corner.
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
- Switching quickly between Live, Movies and Shows (or starting an
  episode, then changing tab) could leave the previous tab's categories
  or lists on screen. Only the newest answer is used now — also in
  Manage categories, what's-on-now, history, account details and the
  favorite star.
- Going to Movies or Shows from live TV stops the channel instead of
  leaving its sound playing behind the library; opening another title
  while a film plays shows its page.
- Escape on a programme card or in search no longer also closes the guide.
- Switching to Movies or Shows from the guide opens the library; Live and
  Guide (and G) always return to live TV.
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
