import { create } from 'zustand'
import { onPlaylistProgress } from '../lib/ipc'
import type { UnlistenFn } from '@tauri-apps/api/event'

/**
 * Coarse-grained state for a playlist ingest (add or refresh). The Rust
 * side emits a `playlist-progress` event with stages `fetching → parsing →
 * storing → done`; we mirror that here and render a modal while ingest is
 * active so the user can't trigger a second refresh while the first one is
 * busy mutating SQLite.
 *
 * `sourceId` is null until the first event arrives — we still want the
 * modal up during the brief window between "user clicked refresh" and
 * "Rust emitted fetching", so callers flip `begin(id)` themselves before
 * invoking the IPC.
 */
export type IngestStage = 'fetching' | 'parsing' | 'storing' | 'done'

export interface IngestStatus {
  sourceId: number
  sourceName: string
  stage: IngestStage
  count: number
  /** When ingest began, ms — used to render an elapsed-time counter. */
  startedAt: number
}

interface IngestState {
  status: IngestStatus | null

  /** Start tracking an ingest before the first progress event arrives. */
  begin(sourceId: number, sourceName: string): void
  /** Update from a playlist-progress event. */
  update(p: { sourceId: number; stage: IngestStage; count: number }): void
  /** Clear — either ingest finished or the command errored. */
  end(): void
}

export const useIngest = create<IngestState>((set, get) => ({
  status: null,
  begin(sourceId, sourceName) {
    set({
      status: {
        sourceId,
        sourceName,
        stage: 'fetching',
        count: 0,
        startedAt: Date.now(),
      },
    })
  },
  update(p) {
    const s = get().status
    if (!s) return
    // When a new source is being added we don't know the id yet — begin()
    // was called with -1 and we adopt the first event's id so subsequent
    // events line up.
    const idMatches = s.sourceId === p.sourceId || s.sourceId === -1
    if (!idMatches) return
    if (p.stage === 'done') {
      set({ status: null })
      return
    }
    set({
      status: {
        ...s,
        sourceId: p.sourceId,
        stage: p.stage,
        count: p.count || s.count,
      },
    })
  },
  end() {
    set({ status: null })
  },
}))

/**
 * Mount once at app start — wires the Tauri event stream into the store.
 * Returns an unlisten fn for cleanup.
 */
export async function attachIngestListener(): Promise<UnlistenFn> {
  return onPlaylistProgress((p) => {
    useIngest.getState().update({
      sourceId: p.sourceId,
      stage: p.stage as IngestStage,
      count: p.count,
    })
  })
}
