import { create } from 'zustand'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

/**
 * Self-update via Tauri's updater: signed packages listed in a
 * `latest.json` on the release host (see RELEASING.md).
 *
 * Checks quietly at startup and every few hours; a failed check (offline,
 * release host not configured yet) is silent unless the user asked.
 */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'available'; version: string; notes: string | null }
  | { kind: 'downloading'; version: string; progress: number | null }
  | { kind: 'error'; message: string }

interface UpdaterState {
  status: UpdateStatus
  /** `manual` surfaces "up to date" / errors; background checks don't. */
  checkForUpdates(manual?: boolean): Promise<void>
  install(): Promise<void>
}

let pending: Update | null = null

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: { kind: 'idle' },

  async checkForUpdates(manual = false) {
    const s = get().status.kind
    if (s === 'checking' || s === 'downloading') return
    if (manual) set({ status: { kind: 'checking' } })
    try {
      const update = await check()
      if (update) {
        pending = update
        set({ status: { kind: 'available', version: update.version, notes: update.body ?? null } })
      } else if (manual || get().status.kind === 'checking') {
        set({ status: { kind: 'none' } })
      }
    } catch (e) {
      if (manual) set({ status: { kind: 'error', message: String(e).replace(/^Error:\s*/, '') } })
    }
  },

  async install() {
    if (!pending) return
    const version = pending.version
    let total: number | null = null
    let received = 0
    set({ status: { kind: 'downloading', version, progress: null } })
    try {
      await pending.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? null
        else if (ev.event === 'Progress') {
          received += ev.data.chunkLength
          set({ status: { kind: 'downloading', version, progress: total ? received / total : null } })
        }
      })
      // On Windows the installer takes over and restarts the app itself;
      // elsewhere we relaunch into the new version.
      await relaunch()
    } catch (e) {
      set({ status: { kind: 'error', message: String(e).replace(/^Error:\s*/, '') } })
    }
  },
}))

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Mount once: check shortly after launch, then periodically. */
export function startUpdateChecks(): () => void {
  if (import.meta.env.DEV) return () => {}
  const run = () => useUpdater.getState().checkForUpdates(false)
  const first = window.setTimeout(run, 5_000)
  const every = window.setInterval(run, CHECK_INTERVAL_MS)
  return () => {
    window.clearTimeout(first)
    window.clearInterval(every)
  }
}
