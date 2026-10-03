import { create } from 'zustand'
import type { HistoryEntry, HistoryProgress } from '../types'
import { ipc } from '../lib/ipc'

/**
 * Watch-history mirror. The authoritative copy lives in SQLite on the Rust
 * side; we keep a Zustand-backed cache so channel rows can synchronously
 * look up "does this movie have a progress bar?" without round-tripping
 * IPC per paint.
 *
 * Progress is keyed by `channel.id`. Entries are upserted on every save
 * and evicted when the user deletes them or clears the whole list.
 */
interface HistoryState {
  /** Full rows (Channel + progress) for the History view. Loaded on demand. */
  entries: HistoryEntry[]
  loading: boolean

  /** Fast lookup by channel id — what ChannelRow reads. Hydrated once on
   *  app boot so the first paint already has the right badges. */
  progress: Map<number, HistoryProgress>

  /** Pull the full joined list from SQLite — used when the sidebar is
   *  showing the History group. */
  loadEntries(): Promise<void>

  /** Pull the lightweight progress map. Called once on boot. */
  loadProgress(): Promise<void>

  /** Write a progress tick. Updates the local map optimistically so the
   *  UI reflects the new position immediately. */
  record(channelId: number, timePos: number, duration: number, finished: boolean): Promise<void>

  remove(channelId: number): Promise<void>
  clear(): Promise<void>
}

// Saves and removals made while a load is in flight would be undone by its
// (older) answer; count them, and reload instead of applying stale data.
let writes = 0
let entriesTicket = 0
let progressTicket = 0

export const useHistory = create<HistoryState>((set, get) => ({
  entries: [],
  loading: false,
  progress: new Map(),

  async loadEntries() {
    const ticket = ++entriesTicket
    const w = writes
    set({ loading: true })
    try {
      const entries = await ipc.listHistory()
      if (ticket !== entriesTicket) return
      if (w !== writes) return get().loadEntries()
      set({ entries })
    } finally {
      if (ticket === entriesTicket) set({ loading: false })
    }
  },

  async loadProgress() {
    const ticket = ++progressTicket
    const w = writes
    const rows = await ipc.listHistoryProgress()
    if (ticket !== progressTicket) return
    if (w !== writes) return get().loadProgress()
    const next = new Map<number, HistoryProgress>()
    for (const r of rows) next.set(r.channelId, r)
    set({ progress: next })
  },

  async record(channelId, timePos, duration, finished) {
    writes++
    await ipc.recordHistory({ channelId, timePos, duration, finished })
    const next = new Map(get().progress)
    const prev = next.get(channelId)
    const watchedAt = Math.floor(Date.now() / 1000)
    next.set(channelId, {
      channelId,
      timePos,
      duration: duration > 0 ? duration : prev?.duration ?? 0,
      watchedAt,
      finished: finished || (prev?.finished ?? false),
    })
    set({ progress: next })
  },

  async remove(channelId) {
    writes++
    await ipc.removeHistoryEntry(channelId)
    const next = new Map(get().progress)
    next.delete(channelId)
    set({
      progress: next,
      entries: get().entries.filter((e) => e.channel.id !== channelId),
    })
  },

  async clear() {
    writes++
    await ipc.clearHistory()
    set({ progress: new Map(), entries: [] })
  },
}))

/** Minimum seconds watched before we treat a position as worth resuming;
 *  anything earlier is typically a misclick that closed the player. */
export const MIN_RESUMABLE = 10
/** Seconds-from-end inside which we stop offering Resume — the file is
 *  effectively done. */
export const END_GUARD = 30

/** Does this channel have a meaningful, resumable position? Used by
 *  ChannelRow to decide between a progress bar and nothing. */
export function isResumable(p: HistoryProgress | undefined): p is HistoryProgress {
  if (!p) return false
  if (p.finished) return false
  if (p.duration <= 0) return false
  if (p.timePos < MIN_RESUMABLE) return false
  if (p.timePos >= p.duration - END_GUARD) return false
  return true
}

/** mm:ss or hh:mm:ss. Shared with the controls' scrub-time renderer. */
export function fmtResume(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`
}
