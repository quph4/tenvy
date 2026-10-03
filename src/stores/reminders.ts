import { create } from 'zustand'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { ipc } from '../lib/ipc'
import { hhmm } from '../lib/time'
import type { Channel, Programme, Reminder } from '../types'
import { usePlayback } from './playback'
import { usePlaylist } from './playlist'
import { useToast } from './toast'
import { useUI } from './ui'

/**
 * "Remind me" for guide programmes. Reminders live in SQLite (they survive
 * restarts); this store mirrors them and fires them: a Windows
 * notification plus an in-app toast with "Watch now", shortly before the
 * programme starts.
 */
interface RemindersState {
  items: Reminder[]
  load(): Promise<void>
  has(channelId: number, start: number): boolean
  toggle(channel: Channel, programme: Programme): Promise<boolean>
  remove(channelId: number, start: number): Promise<void>
}

/** Fire this long before the start, so there's time to tune in. */
const LEAD_SECONDS = 60
const CHECK_INTERVAL_MS = 10_000

export const useReminders = create<RemindersState>((set, get) => ({
  items: [],

  async load() {
    set({ items: await ipc.listReminders() })
  },

  has(channelId, start) {
    return get().items.some((r) => r.channel.id === channelId && r.start === start)
  },

  async toggle(channel, p) {
    if (get().has(channel.id, p.start)) {
      await get().remove(channel.id, p.start)
      return false
    }
    await ipc.addReminder(channel.id, { start: p.start, stop: p.stop, title: p.title })
    await ensureNotificationPermission()
    await get().load()
    return true
  },

  async remove(channelId, start) {
    await ipc.removeReminder(channelId, start)
    set({ items: get().items.filter((r) => !(r.channel.id === channelId && r.start === start)) })
  },
}))

async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true
    return (await requestPermission()) === 'granted'
  } catch {
    return false
  }
}

function watchNow(r: Reminder) {
  usePlaylist.getState().setActiveKind('live').catch(() => {})
  useUI.getState().setView('player')
  usePlayback.getState().requestPlay(r.channel)
  const w = getCurrentWindow()
  w.unminimize().then(() => w.setFocus()).catch(() => {})
}

function fire(r: Reminder) {
  const when = r.start <= Date.now() / 1000 ? 'is starting now' : `starts at ${hhmm(r.start)}`
  const message = `${r.title} ${when} on ${r.channel.name}`
  // Windows notification for when Tenvy is in the background…
  ensureNotificationPermission()
    .then((ok) => ok && sendNotification({ title: 'Tenvy reminder', body: message }))
    .catch(() => {})
  // …and a toast with a direct way in.
  useToast.getState().push('reminder', message, { action: { label: 'Watch now', run: () => watchNow(r) } })
}

/** Mount once: load reminders and fire them as their programmes start. */
export function startReminderScheduler(): () => void {
  const { load } = useReminders.getState()
  load().catch(() => {})
  const tick = () => {
    const now = Date.now() / 1000
    for (const r of useReminders.getState().items) {
      // Due, and not already over (e.g. the app was closed through it).
      if (r.start - LEAD_SECONDS <= now && r.stop > now) {
        fire(r)
        useReminders.getState().remove(r.channel.id, r.start).catch(() => {})
      }
    }
  }
  const t = window.setInterval(tick, CHECK_INTERVAL_MS)
  tick()
  return () => window.clearInterval(t)
}
