import { ipc } from './ipc'
import type { RestoreReport } from '../types'
import { usePlaylist } from '../stores/playlist'
import { useParental } from '../stores/parental'
import { useHistory } from '../stores/history'
import { useReminders } from '../stores/reminders'
import { reloadTvPrefs } from '../stores/tvPrefs'

/**
 * Preferences kept in the webview's storage that travel with a backup.
 * Left out: things tied to this install (last channel id, notices seen).
 */
const SETTINGS_KEYS = [
  'tenvy.aspect',
  'tenvy.channels.sort',
  'tenvy.library.sort',
  'tenvy.sidebar.groupSort',
  'tenvy.sidebar.pinned',
  'tenvy.startWithLastChannel',
  'tenvy.trackPrefs',
  'tenvy.dailyRefresh',
  'tenvy.autoNext',
]

function collectSettings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SETTINGS_KEYS) {
    try {
      const v = localStorage.getItem(key)
      if (v != null) out[key] = v
    } catch {
      /* storage unavailable: settings just don't travel */
    }
  }
  return out
}

function applySettings(settings: unknown) {
  if (!settings || typeof settings !== 'object') return
  for (const key of SETTINGS_KEYS) {
    const v = (settings as Record<string, unknown>)[key]
    if (typeof v !== 'string') continue
    try {
      localStorage.setItem(key, v)
    } catch {
      /* ignore */
    }
  }
  reloadTvPrefs()
}

/** Save a backup; resolves to the file's path, or null if cancelled. */
export function saveBackup(): Promise<string | null> {
  return ipc.exportBackup(collectSettings())
}

/** Restore one; null if cancelled. Everything on screen reloads after. */
export async function restoreBackup(): Promise<RestoreReport | null> {
  const report = await ipc.restoreBackup()
  if (!report) return null
  applySettings(report.settings)
  await Promise.allSettled([
    usePlaylist.getState().hydrate(),
    useParental.getState().refresh(),
    useParental.getState().loadWords(),
    useHistory.getState().loadProgress(),
    useReminders.getState().load(),
  ])
  return report
}

/** One line on what a restore did. */
export function describeRestore(r: RestoreReport): string {
  const parts = [
    r.sourcesAdded ? `${r.sourcesAdded} ${r.sourcesAdded === 1 ? 'provider' : 'providers'} added` : null,
    r.favorites ? `${r.favorites} favorites` : null,
    r.history ? `${r.history} watched` : null,
    r.hiddenChannels ? `${r.hiddenChannels} hidden channels` : null,
    r.categories ? `${r.categories} category choices` : null,
    r.pinRestored ? 'parental PIN' : null,
  ].filter(Boolean)
  const done = parts.length ? `Restored: ${parts.join(', ')}.` : 'Restored. Everything in the backup was already here.'
  const missing = r.notFound ? ` ${r.notFound} no longer offered by the provider.` : ''
  return done + missing
}
