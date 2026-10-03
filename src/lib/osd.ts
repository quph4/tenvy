import { ipc } from './ipc'
import { hhmm } from './time'
import type { Channel } from '../types'
export { liveChannels, channelNumber } from './channels'
import { usePlayback } from '../stores/playback'
import { channelNumber } from './channels'
import { useToast } from '../stores/toast'

/**
 * On-screen display: text mpv draws over the picture. The native video
 * surface covers the webview, so in fullscreen this is the only way to
 * show anything on top of the video.
 */
export function osd(text: string, durationMs = 4000) {
  ipc.mpvShowText(text, durationMs).catch(() => {})
}

/** TV-style banner after switching channel: number, name, now and next. */
export async function showChannelInfo(ch: Channel) {
  const n = channelNumber(ch)
  const lines = [n ? `${n}   ${ch.name}` : ch.name]
  if (ch.tvgId) {
    const t = Math.floor(Date.now() / 1000)
    const progs = await ipc.programmesForChannels({ tvgIds: [ch.tvgId], from: t, to: t + 6 * 3600 }).catch(() => [])
    const [now, next] = progs
    if (now && now.start <= t) {
      const left = Math.max(1, Math.round((now.stop - t) / 60))
      lines.push(`Now    ${now.title}    ${hhmm(now.start)}–${hhmm(now.stop)} · ${left} min left`)
    }
    const upcoming = now && now.start > t ? now : next
    if (upcoming) lines.push(`Next   ${upcoming.title}    ${hhmm(upcoming.start)}`)
  }
  // Skip it if the viewer already moved on while the guide loaded.
  if (usePlayback.getState().channel?.id === ch.id) osd(lines.join('\n'), 4500)
}

/**
 * Mirror toasts onto the video while in fullscreen, where the webview
 * (and so the toast) is hidden. A toast's action, like "Watch now" on a
 * reminder, is offered as "press Enter" — see useKeyboard.
 */
export function startToastMirror(): () => void {
  let seen = new Set(useToast.getState().items.map((t) => t.id))
  return useToast.subscribe((s) => {
    const fresh = s.items.filter((t) => !seen.has(t.id))
    seen = new Set(s.items.map((t) => t.id))
    if (!usePlayback.getState().fullscreen) return
    for (const t of fresh) {
      osd(t.action ? `${t.message}\nPress Enter: ${t.action.label}` : t.message, t.action ? 10_000 : 5000)
    }
  })
}
