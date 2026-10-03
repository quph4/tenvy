import { create } from 'zustand'
import { ipc } from '../lib/ipc'
import type { ParentalStatus } from '../types'
import { usePlaylist } from './playlist'
import { usePlayback } from './playback'

/**
 * Parental PIN. Categories marked locked stay out of lists, search and
 * playback (enforced in Rust) until the PIN is entered; then they're open
 * until "Lock now" or the app restarts.
 */
interface ParentalState {
  status: ParentalStatus
  /** The PIN prompt on screen, if any. */
  prompt: { reason: string } | null
  refresh(): Promise<void>
  /** Ask for the PIN when needed. Resolves true once locked content may show. */
  requireUnlocked(reason: string): Promise<boolean>
  /** From the prompt: check a PIN. False if wrong. */
  submit(pin: string): Promise<boolean>
  cancel(): void
  lock(): Promise<void>
  setPin(current: string | null, next: string | null): Promise<void>
}

let waiting: ((ok: boolean) => void) | null = null

/** Lists change with the lock state; reload what's on screen. */
function reloadLists() {
  usePlaylist.getState().hydrate().catch(() => {})
}

export const useParental = create<ParentalState>((set, get) => ({
  status: { pinSet: false, unlocked: true },
  prompt: null,

  async refresh() {
    set({ status: await ipc.parentalStatus() })
  },

  requireUnlocked(reason) {
    if (get().status.unlocked) return Promise.resolve(true)
    waiting?.(false)
    set({ prompt: { reason } })
    return new Promise((resolve) => {
      waiting = resolve
    })
  },

  async submit(pin) {
    const ok = await ipc.parentalUnlock(pin)
    if (!ok) return false
    await get().refresh()
    set({ prompt: null })
    waiting?.(true)
    waiting = null
    reloadLists()
    return true
  },

  cancel() {
    set({ prompt: null })
    waiting?.(false)
    waiting = null
  },

  async lock() {
    await ipc.parentalLock()
    await get().refresh()
    reloadLists()
    // Locking also ends a locked channel that's on screen.
    const pb = usePlayback.getState()
    if (pb.channel && (await ipc.isChannelLocked(pb.channel.id).catch(() => false))) {
      pb.stop()
      ipc.mpvStop().catch(() => {})
    }
  },

  async setPin(current, next) {
    await ipc.setParentalPin(current, next)
    await get().refresh()
    reloadLists()
  },
}))
