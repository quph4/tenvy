import { create } from 'zustand'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { ipc } from '../lib/ipc'
import { useToast } from './toast'

/**
 * Self-update via Tauri's updater: signed packages listed in a
 * `latest.json` on the release host (see RELEASING.md).
 *
 * Checks quietly at startup and every few hours; a failed check (offline,
 * release host not configured yet) is silent unless the user asked.
 * A new version is offered in a dialog (UpdatePrompt) — never installed
 * without the user saying so. "Later" asks again the next day; the
 * Update button in the top bar stays meanwhile.
 *
 * The Microsoft Store version never updates itself: the Store does that
 * (status `store`).
 */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'available'; version: string; notes: string | null }
  | { kind: 'downloading'; version: string; progress: number | null }
  | { kind: 'error'; message: string }
  /** The Microsoft Store version: the Store keeps it up to date. */
  | { kind: 'store' }

interface UpdaterState {
  status: UpdateStatus
  /** The "a new version is available" dialog is wanted. */
  prompt: boolean
  /** `manual` surfaces "up to date" / errors; background checks don't. */
  checkForUpdates(manual?: boolean): Promise<void>
  install(): Promise<void>
  /** "Later": close the dialog; ask again tomorrow. */
  later(): void
  /** Open the dialog for the pending update (the top-bar button). */
  showPrompt(): void
}

const PROMPTED_KEY = 'tenvy.updatePrompted'
const ASK_AGAIN_MS = 24 * 60 * 60 * 1000

/** Whether a background check may open the dialog for this version. */
function mayPrompt(version: string): boolean {
  try {
    const last = JSON.parse(localStorage.getItem(PROMPTED_KEY) ?? 'null') as { version: string; at: number } | null
    return !last || last.version !== version || Date.now() - last.at > ASK_AGAIN_MS
  } catch {
    return true
  }
}

let pending: Update | null = null

let storeVersion: Promise<boolean> | null = null
/** Whether this is the Microsoft Store version (asked once). */
function isStoreVersion(): Promise<boolean> {
  storeVersion ??= ipc.distribution().then((d) => d === 'store').catch(() => false)
  return storeVersion
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: { kind: 'idle' },
  prompt: false,
  later() {
    const s = get().status
    if (s.kind === 'available') {
      try {
        localStorage.setItem(PROMPTED_KEY, JSON.stringify({ version: s.version, at: Date.now() }))
      } catch {
        /* ignore */
      }
    }
    set({ prompt: false })
  },
  showPrompt() {
    set({ prompt: true })
  },

  async checkForUpdates(manual = false) {
    const s = get().status.kind
    if (s === 'checking' || s === 'downloading') return
    if (await isStoreVersion()) {
      set({ status: { kind: 'store' } })
      if (manual) useToast.getState().push('info', 'Tenvy is kept up to date by the Microsoft Store.')
      return
    }
    if (manual) set({ status: { kind: 'checking' } })
    try {
      const update = await check()
      if (update) {
        pending = update
        set({
          status: { kind: 'available', version: update.version, notes: update.body ?? null },
          prompt: manual || mayPrompt(update.version),
        })
      } else if (manual || get().status.kind === 'checking') {
        set({ status: { kind: 'none' } })
      }
    } catch (e) {
      if (manual) set({ status: { kind: 'error', message: String(e).replace(/^Error:\s*/, '') } })
    }
  },

  async install() {
    if (!pending || (await isStoreVersion())) return
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
