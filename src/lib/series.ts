import type { Channel } from '../types'

/**
 * Parse an episode marker out of a channel / VOD title.
 *
 * IPTV providers name series episodes with one of a handful of conventions:
 *   "Breaking Bad S01E05 - Gray Matter"
 *   "Breaking Bad S1 E5"
 *   "Breaking Bad 1x05"
 *   "Breaking Bad - 01x05 - Gray Matter"
 *
 * We strip the marker, whatever shape it took, and return the show name,
 * season, and episode. If no marker is found we fall back to `null` so the
 * caller can leave the channel ungrouped.
 */
export interface EpisodeInfo {
  show: string
  season: number
  episode: number
  subtitle: string | null
}

// S01E05 / S1 E05 / S 1 E 5
const SXX_EXX = /\b[Ss]\s*(\d{1,3})\s*[Ee]\s*(\d{1,3})\b/
// 01x05 / 1x05
const N_X_N = /\b(\d{1,3})\s*[xX]\s*(\d{1,3})\b/

export function parseEpisode(name: string): EpisodeInfo | null {
  let match = name.match(SXX_EXX)
  if (!match) match = name.match(N_X_N)
  if (!match || match.index === undefined) return null

  const season = parseInt(match[1], 10)
  const episode = parseInt(match[2], 10)
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null

  const before = name.slice(0, match.index)
  const after = name.slice(match.index + match[0].length)
  const show = cleanup(before)
  const subtitle = cleanup(after) || null
  if (!show) return null

  return { show, season, episode, subtitle }
}

/** Trim leading/trailing separators (dashes, dots, whitespace, pipes). */
function cleanup(s: string): string {
  return s.replace(/^[\s\-–—_.·|:]+|[\s\-–—_.·|:]+$/g, '').trim()
}

/** A show with its episode list, sorted by season+episode. */
export interface Show {
  key: string          // normalized show name for dedup
  name: string         // display name (first encountered casing)
  logo: string | null
  group: string | null
  episodes: Episode[]
}

export interface Episode {
  channel: Channel
  season: number
  episode: number
  subtitle: string | null
}

/**
 * Fold a flat channel list into a per-show structure. Channels whose names
 * don't parse as episodes become a "show" with a single episode entry —
 * that way the list stays complete even if the provider names things oddly.
 */
export function groupByShow(channels: Channel[]): Show[] {
  const shows = new Map<string, Show>()

  for (const ch of channels) {
    const info = parseEpisode(ch.name)
    const showName = info?.show ?? ch.name
    const key = showName.toLowerCase()

    let show = shows.get(key)
    if (!show) {
      show = {
        key,
        name: showName,
        logo: ch.logo ?? null,
        group: ch.group ?? null,
        episodes: [],
      }
      shows.set(key, show)
    }

    show.episodes.push({
      channel: ch,
      season: info?.season ?? 0,
      episode: info?.episode ?? 0,
      subtitle: info?.subtitle ?? null,
    })
  }

  for (const s of shows.values()) {
    s.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
  }

  return Array.from(shows.values()).sort((a, b) => a.name.localeCompare(b.name))
}
