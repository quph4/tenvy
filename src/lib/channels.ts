import type { Channel } from '../types'
import { FAVORITES_GROUP, HISTORY_GROUP, usePlaylist } from '../stores/playlist'

/**
 * How the live list is ordered. "added" is the provider's order; "name"
 * is A–Z. Favorites always keep the viewer's own order.
 */
export type SortMode = 'added' | 'name'
export const SORT_KEY = 'tenvy.channels.sort'

export function savedSort(): SortMode {
  try {
    return JSON.parse(localStorage.getItem(SORT_KEY) ?? '"added"') === 'name' ? 'name' : 'added'
  } catch {
    return 'added'
  }
}

export function sortChannels(channels: Channel[], mode: SortMode, keepOrder = false): Channel[] {
  if (keepOrder) return channels
  if (mode === 'added') return [...channels].sort((a, b) => a.sortOrder - b.sortOrder)
  return [...channels].sort((a, b) => a.name.localeCompare(b.name))
}

// Decoration providers wrap their section titles in: "-= Sweden =-",
// "##### SPORT #####", "---- UK ----", "★★ Kids ★★".
const DECOR = '\\s#=\\-*~|_.•·★☆◆◇►◄▶◀<>+:'
const WRAPPED = new RegExp(`^[${DECOR}]{2,}\\s*(.*?)\\s*[${DECOR}]{2,}$`)

/**
 * Provider "channels" that are really section titles in the list. They
 * don't play; we show them as headings and skip them when numbering and
 * zapping.
 */
export function isSeparator(ch: Pick<Channel, 'name' | 'kind'>): boolean {
  if (ch.kind !== 'live') return false
  const name = ch.name.trim()
  return !/[\p{L}\p{N}]/u.test(name) || WRAPPED.test(name)
}

/** "-= Sweden =-" → "Sweden". */
export function separatorTitle(name: string): string {
  return name.trim().match(WRAPPED)?.[1]?.trim() || name.replace(new RegExp(`[${DECOR}]`, 'g'), ' ').trim() || '—'
}

/**
 * The live channels on screen in display order, without section titles:
 * what channel numbers count and what ↑/↓ zap through.
 */
export function liveChannels(): Channel[] {
  const pl = usePlaylist.getState()
  const live = pl.channels.filter((c) => c.kind === 'live' && !isSeparator(c))
  // Favorites keep their own order and History its most-recent-first.
  return sortChannels(live, savedSort(), pl.activeGroup === FAVORITES_GROUP || pl.activeGroup === HISTORY_GROUP)
}

/** 1-based channel number in the current list, or null. */
export function channelNumber(ch: Channel): number | null {
  const i = liveChannels().findIndex((c) => c.id === ch.id)
  return i === -1 ? null : i + 1
}
