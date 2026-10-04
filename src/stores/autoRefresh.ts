import { ipc } from '../lib/ipc'
import { useIngest } from './ingest'
import { usePlaylist } from './playlist'
import { useTvPrefs } from './tvPrefs'

/**
 * Keeps playlists and guides current without anyone pressing Refresh:
 * a provider not updated for a day is re-imported quietly in the
 * background (lists keep working meanwhile; channel ids, favorites and
 * history survive an import). Only API requests — never a stream.
 */
const DAY_S = 86_400
const FIRST_CHECK_MS = 2 * 60 * 1000
const CHECK_EVERY_MS = 60 * 60 * 1000

let running = false

async function check() {
  if (running || !useTvPrefs.getState().dailyRefresh) return
  // A manual import is on screen; try again next time.
  if (useIngest.getState().status) return
  running = true
  try {
    const now = Date.now() / 1000
    let refreshed = false
    for (const s of usePlaylist.getState().sources) {
      if (now - s.updatedAt < DAY_S) continue
      try {
        await ipc.refreshSource(s.id)
        refreshed = true
      } catch {
        /* offline, or already being refreshed — next hour */
      }
    }
    if (refreshed) await usePlaylist.getState().hydrate()
  } finally {
    running = false
  }
}

/** Call once from App; returns a cleanup. */
export function startAutoRefresh(): () => void {
  const first = window.setTimeout(check, FIRST_CHECK_MS)
  const every = window.setInterval(check, CHECK_EVERY_MS)
  return () => {
    window.clearTimeout(first)
    window.clearInterval(every)
  }
}

/** For tests and "update now": run the check immediately. */
export const autoRefreshNow = check
