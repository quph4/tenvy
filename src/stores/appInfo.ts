import { create } from 'zustand'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ipc } from '../lib/ipc'
import type { AppInfo } from '../types'
import { useHistory } from './history'
import { usePlayback } from './playback'
import { useToast } from './toast'

/**
 * The remote config (business model, support link, announcements) and the
 * install date. Loaded at startup and twice a day; when offline the
 * backend hands back the last copy it saw.
 */
interface AppInfoState {
  info: AppInfo | null
  load(): Promise<void>
}

export const useAppInfo = create<AppInfoState>((set) => ({
  info: null,
  async load() {
    try {
      set({ info: await ipc.appInfo() })
    } catch {
      /* keep what we had — everything here is optional */
    }
  },
}))

/** Open a link from the config; only https ever gets this far. */
export function openSupportLink() {
  const url = useAppInfo.getState().info?.config.support?.url
  if (url?.startsWith('https://')) openUrl(url).catch(() => {})
}

const DAY = 86_400
const RELOAD_MS = 12 * 60 * 60 * 1000
/** Settle in before showing anything. */
const ANNOUNCE_DELAY_MS = 8_000
const PROMPT_DELAY_MS = 3 * 60 * 1000

const SEEN_KEY = 'tenvy.seenAnnouncements'
const PROMPTED_KEY = 'tenvy.supportPromptAt'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* not worth failing over */
  }
}

/** Each announcement once per install, newest config wins. */
function showAnnouncements() {
  const info = useAppInfo.getState().info
  if (!info) return
  const seen = new Set(readJson<string[]>(SEEN_KEY, []))
  const fresh = info.config.announcements.filter((a) => !seen.has(a.id))
  for (const a of fresh) {
    const url = a.url
    useToast.getState().push('info', a.text, {
      duration: 20_000,
      action: url ? { label: 'Learn more', run: () => openUrl(url).catch(() => {}) } : undefined,
    })
    seen.add(a.id)
  }
  if (fresh.length) writeJson(SEEN_KEY, [...seen])
}

/**
 * Now and then, ask for support — only once someone has used Tenvy for a
 * while and actually watched something, never during fullscreen, and no
 * more often than the config allows.
 */
function maybeAskForSupport() {
  const info = useAppInfo.getState().info
  const support = info?.config.support
  const rule = info?.config.supportPrompt
  if (!info || !support || !rule) return

  const now = Date.now() / 1000
  if (now - info.installedAt < rule.afterDays * DAY) return
  const last = readJson<number | null>(PROMPTED_KEY, null)
  if (last != null && now - last < rule.everyDays * DAY) return
  if (useHistory.getState().progress.size === 0) return
  const pb = usePlayback.getState()
  if (pb.fullscreen || pb.mini) return

  writeJson(PROMPTED_KEY, Math.floor(now))
  useToast.getState().push(
    'support',
    support.message ?? "Enjoying Tenvy? It's free — if you'd like to help keep it going, you can support it.",
    { duration: 45_000, action: { label: support.label ?? 'Support Tenvy', run: openSupportLink } },
  )
}

/** Call once from App; returns a cleanup. */
export function startAppInfo(): () => void {
  const load = useAppInfo.getState().load
  const timers = [
    setTimeout(() => load().then(() => setTimeout(showAnnouncements, ANNOUNCE_DELAY_MS)), 0),
    setTimeout(maybeAskForSupport, PROMPT_DELAY_MS),
  ]
  const interval = setInterval(() => load().then(showAnnouncements), RELOAD_MS)
  return () => {
    timers.forEach(clearTimeout)
    clearInterval(interval)
  }
}
