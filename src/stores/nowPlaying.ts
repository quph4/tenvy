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
let flushTimer: number | null = null

export const useNowPlayingStore = create<NowPlayingState>((set, get) => ({
  byId: new Map(),

  request(tvgId) {
    const cached = get().byId.get(tvgId)
    const now = Date.now() / 1000
    if (cached !== undefined && (cached === null || cached.stop > now)) return
    pending.add(tvgId)
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(() => {
      flushTimer = null
      const ids = [...pending]
      pending.clear()
      ipc
        .nowPlaying(ids)
        .then((rows) => {
          const next = new Map(get().byId)
          for (const id of ids) next.set(id, null)
          for (const p of rows) next.set(p.channelTvgId, p)
          set({ byId: next })
        })
        .catch(() => {})
    }, 30)
  },

  invalidate() {
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
  // Refetch when the programme ends while the row stays on screen.
  useEffect(() => {
    if (!key || !entry) return
    const ms = entry.stop * 1000 - Date.now()
    if (ms <= 0) return
    const t = window.setTimeout(() => useNowPlayingStore.getState().request(key), ms + 1000)
    return () => window.clearTimeout(t)
  }, [key, entry])
  return entry && !expired ? entry : null
}

/** Mount once: drop cached guide data when a new guide has been stored. */
export async function attachGuideListener(): Promise<() => void> {
  return listen('guide-updated', () => useNowPlayingStore.getState().invalidate())
}
