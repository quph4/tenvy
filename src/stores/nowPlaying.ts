import { useEffect } from 'react'
import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import { ipc } from '../lib/ipc'
import type { Programme } from '../types'

/**
 * "What's on now" for channel rows, batched.
 *
 * Each visible row asks for its guide id; requests made in the same tick
 * are collected into a single `now_playing` call instead of one IPC round
 * trip per row. Entries are refetched once their programme ends, and the
 * whole cache is dropped when the backend reports a fresh guide.
 */
interface NowPlayingState {
  /** tvgId → current programme, or null when the guide has nothing. */
  byId: Map<string, Programme | null>
  request(tvgId: string): void
  invalidate(): void
}

const pending = new Set<string>()
/** When an id last came back with nothing on; retried after EMPTY_TTL_MS. */
const emptyAt = new Map<string, number>()
const EMPTY_TTL_MS = 5 * 60 * 1000
let flushTimer: number | null = null
/** Bumped when a new guide lands; answers from before it are dropped. */
let generation = 0

export const useNowPlayingStore = create<NowPlayingState>((set, get) => ({
  byId: new Map(),

  request(tvgId) {
    const cached = get().byId.get(tvgId)
    const now = Date.now() / 1000
    if (cached != null && cached.stop > now) return
    if (cached === null && Date.now() - (emptyAt.get(tvgId) ?? 0) < EMPTY_TTL_MS) return
    pending.add(tvgId)
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(() => {
      flushTimer = null
      const ids = [...pending]
      pending.clear()
      const gen = generation
      ipc
        .nowPlaying(ids)
        .then((rows) => {
          if (gen !== generation) {
            // Asked about the old guide; ask again about the new one.
            ids.forEach((id) => get().request(id))
            return
          }
          const next = new Map(get().byId)
          for (const id of ids) {
            next.set(id, null)
            emptyAt.set(id, Date.now())
          }
          for (const p of rows) next.set(p.channelTvgId, p)
          set({ byId: next })
        })
        .catch(() => {})
    }, 30)
  },

  invalidate() {
    generation++
    emptyAt.clear()
    set({ byId: new Map() })
  },
}))

/** Current programme for a guide id; triggers a (batched) fetch. */
export function useNowPlaying(tvgId: string | null): Programme | null {
  const key = tvgId?.toLowerCase() ?? null
  const entry = useNowPlayingStore((s) => (key ? s.byId.get(key) : undefined))
  const expired = entry != null && entry.stop <= Date.now() / 1000
  useEffect(() => {
    if (key && (entry === undefined || expired)) useNowPlayingStore.getState().request(key)
  }, [key, entry, expired])
  // Refetch when the programme ends while the row stays on screen, or
  // periodically while nothing is on (a programme may start later).
  useEffect(() => {
    if (!key || entry === undefined) return
    const refetch = () => useNowPlayingStore.getState().request(key)
    if (entry === null) {
      // An interval, not a timeout: a retry that again finds nothing
      // leaves `entry` unchanged, so this effect wouldn't re-arm.
      const t = window.setInterval(refetch, EMPTY_TTL_MS + 1000)
      return () => window.clearInterval(t)
    }
    const ms = entry.stop * 1000 - Date.now() + 1000
    if (ms <= 0) return
    const t = window.setTimeout(refetch, ms)
    return () => window.clearTimeout(t)
  }, [key, entry])
  return entry && !expired ? entry : null
}

/** Mount once: drop cached guide data when a new guide has been stored. */
export async function attachGuideListener(): Promise<() => void> {
  return listen('guide-updated', () => useNowPlayingStore.getState().invalidate())
}
