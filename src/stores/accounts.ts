import { create } from 'zustand'
import { ipc } from '../lib/ipc'
import type { AccountInfo, Source } from '../types'
import { useToast } from './toast'
import { usePlaylist } from './playlist'

/**
 * Subscription details per Xtream source (status, expiry, connections),
 * fetched from the provider's API at startup and when Settings opens.
 */
interface AccountsState {
  bySource: Record<number, AccountInfo | null>
  load(source: Source): Promise<void>
  loadAll(sources: Source[]): Promise<void>
}

const DAY = 86_400
const WARN_DAYS = 7
const WARNED_KEY = 'tenvy.expiryWarnedAt'

export const useAccounts = create<AccountsState>((set, get) => ({
  bySource: {},
  async load(source) {
    if (source.kind !== 'xtream') return
    try {
      const info = await ipc.accountInfo(source.id)
      // The provider may have been removed while we asked.
      if (!usePlaylist.getState().sources.some((s) => s.id === source.id)) return
      set({ bySource: { ...get().bySource, [source.id]: info } })
    } catch {
      /* offline or the panel is down — keep what we had */
    }
  },
  async loadAll(sources) {
    await Promise.all(sources.map((s) => get().load(s)))
    warnIfExpiring(sources, get().bySource)
  },
}))

/** Whole days left, or null without an expiry. */
export function daysLeft(info: AccountInfo | null | undefined): number | null {
  if (!info?.expiresAt) return null
  return Math.floor((info.expiresAt - Date.now() / 1000) / DAY)
}

export function expiryLabel(info: AccountInfo): string {
  if (!info.expiresAt) return 'No expiry date'
  const date = new Date(info.expiresAt * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const left = daysLeft(info)!
  if (left < 0) return `Expired ${date}`
  if (left === 0) return `Expires today`
  return `Expires ${date} · ${left} day${left === 1 ? '' : 's'} left`
}

/** Once a day at most: a heads-up when a subscription is about to run out. */
function warnIfExpiring(sources: Source[], bySource: Record<number, AccountInfo | null>) {
  let last = 0
  try {
    last = Number(localStorage.getItem(WARNED_KEY)) || 0
  } catch {
    /* ignore */
  }
  if (Date.now() / 1000 - last < DAY) return
  for (const s of sources) {
    const left = daysLeft(bySource[s.id])
    if (left == null || left > WARN_DAYS) continue
    const msg =
      left < 0
        ? `Your ${s.name} subscription has expired. Renew it with your provider to keep watching.`
        : `Your ${s.name} subscription ends ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}. Renew it with your provider.`
    useToast.getState().push('info', msg, { duration: 15_000 })
    try {
      localStorage.setItem(WARNED_KEY, String(Math.floor(Date.now() / 1000)))
    } catch {
      /* ignore */
    }
    return
  }
}
