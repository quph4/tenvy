import { useEffect } from 'react'
import { usePlayback } from '../stores/playback'
import { usePlaylist } from '../stores/playlist'
import { useUI } from '../stores/ui'
import { useToast } from '../stores/toast'
import { ipc } from '../lib/ipc'
import { openInExternalPlayer } from '../lib/externalPlayer'
import { liveChannels, osd } from '../lib/osd'
import { cycleAspect, showStreamInfo } from '../lib/picture'

/** Wait this long after the last digit before switching channel. */
const DIGIT_WAIT_MS = 1500

/**
 * Global keyboard shortcuts. Mounted once from App.
 *
 *   Ctrl+K   open search
 *   G        toggle EPG grid view
 *   Esc      close overlays
 *   Space    play/pause (when not typing)
 *   F        fullscreen
 *   P        mini player (small always-on-top window)
 *   M        mute
 *   X        open current channel in external player (mpv / VLC)
 *   J / L    seek -10s / +10s (VOD only)
 *   ↑ / ↓    prev/next channel (live, player view; also PgUp/PgDn)
 *   0–9      go to channel number (live, player view)
 *   Backspace  back to the previous channel
 *   Enter    in fullscreen: the action of the latest notice ("Watch now")
 *   A        picture shape (auto, 16:9, 4:3, fill, stretch)
 *   I        stream info on screen
 *   ← / →    volume down/up
 *
 * State is read with `getState()` at key time rather than subscribed to:
 * this hook lives in App, and subscribing to the playback store would
 * re-render the whole tree on every position tick during playback.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    // Digits typed so far for "go to channel 12".
    let digits = ''
    let digitTimer: ReturnType<typeof setTimeout> | undefined
    const commitDigits = () => {
      clearTimeout(digitTimer)
      const n = Number(digits)
      digits = ''
      const list = liveChannels()
      const target = list[n - 1]
      if (target) usePlayback.getState().play(target)
      else osd(`No channel ${n}`, 1500)
    }

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const ui = useUI.getState()
      const pb = usePlayback.getState()
      const channel = pb.channel

      // Global — work even while typing
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        ui.searchOpen ? ui.closeSearch() : ui.openSearch()
        return
      }
      if (e.key === 'Escape') {
        if (ui.searchOpen || ui.addSourceOpen || ui.settingsOpen || ui.manageCategoriesOpen) return // those handle their own escape
        if (pb.pendingResume) return // ResumePrompt handles its own escape
        if (pb.mini) pb.setMini(false)
        else if (pb.fullscreen) pb.setFullscreen(false)
        else if (ui.view === 'epg') ui.setView('player')
        return
      }

      if (typing) return

      // Channel numbers: live TV in the player view (or fullscreen).
      if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const live = usePlaylist.getState().activeKind === 'live' || channel?.kind === 'live'
        if (!live || ui.view !== 'player') return
        if (!digits && e.key === '0') return
        e.preventDefault()
        digits = (digits + e.key).slice(0, 4)
        osd(`${digits}–`, DIGIT_WAIT_MS + 300)
        clearTimeout(digitTimer)
        digitTimer = setTimeout(commitDigits, DIGIT_WAIT_MS)
        return
      }

      switch (e.key.toLowerCase()) {
        case 'enter': {
          if (digits) {
            e.preventDefault()
            commitDigits()
            return
          }
          // In fullscreen notices appear on the video; Enter answers the
          // latest one that offers something ("Watch now").
          if (!pb.fullscreen) return
          const toasts = useToast.getState()
          const t = [...toasts.items].reverse().find((x) => x.action)
          if (!t?.action) return
          e.preventDefault()
          t.action.run()
          toasts.dismiss(t.id)
          break
        }
        case 'a':
          if (!channel) return
          e.preventDefault()
          cycleAspect()
          break
        case 'i':
          if (!channel) return
          e.preventDefault()
          showStreamInfo().catch(() => {})
          break
        case 'backspace': {
          const prev = pb.previous
          if (!prev || channel?.kind !== 'live' || ui.view !== 'player') return
          e.preventDefault()
          pb.play(prev)
          break
        }
        case 'g': {
          e.preventDefault()
          if (ui.view === 'epg') {
            ui.setView('player')
            break
          }
          // The guide shows live channels; jump there from the library.
          const pl = usePlaylist.getState()
          if (pl.activeKind !== 'live') pl.setActiveKind('live').catch(() => {})
          ui.setView('epg')
          break
        }
        case ' ':
          if (!channel) return
          e.preventDefault()
          pb.setPlaying(!pb.playing)
          break
        case 'f':
          if (!channel || ui.view !== 'player') return
          e.preventDefault()
          pb.setFullscreen(!pb.fullscreen)
          break
        case 'p':
          if (!channel) return
          e.preventDefault()
          if (!pb.mini) ui.setView('player')
          pb.setMini(!pb.mini)
          break
        case 'm':
          if (!channel) return
          e.preventDefault()
          pb.toggleMute()
          break
        case 'x': {
          if (!channel) return
          e.preventDefault()
          const { push } = useToast.getState()
          openInExternalPlayer()
            .then((p) => push('success', `Launched ${p.split(/[\\/]/).pop() ?? p}`))
            .catch((err) => push('error', String(err)))
          break
        }
        case 'j':
        case 'l': {
          // ±10s relative seek via mpv. Live streams still accept a seek
          // but it's a no-op inside their tiny buffer — no need to guard.
          if (!channel) return
          const { timePos, duration } = pb
          if (timePos == null || duration == null || duration <= 0) return
          e.preventDefault()
          const delta = e.key.toLowerCase() === 'j' ? -10 : 10
          ipc.mpvSeek(Math.max(0, Math.min(duration, timePos + delta))).catch(() => {})
          break
        }
        case 'arrowup':
        case 'arrowdown':
        case 'pageup':
        case 'pagedown':
        case 'channelup':
        case 'channeldown': {
          // Channel zapping only makes sense for live TV in the player
          // view; in the guide the arrows should scroll.
          if (!channel || channel.kind !== 'live' || ui.view !== 'player') return
          // Zap through the live channels on screen; if the playing channel
          // isn't among them (another tab or group is open), do nothing.
          const channels = liveChannels()
          const i = channels.findIndex((c) => c.id === channel.id)
          if (i === -1) return
          e.preventDefault()
          const step = ['arrowup', 'pageup', 'channelup'].includes(e.key.toLowerCase()) ? -1 : 1
          pb.play(channels[(i + step + channels.length) % channels.length])
          break
        }
        case 'arrowleft':
        case 'arrowright':
          if (!channel) return
          e.preventDefault()
          pb.setVolume(pb.volume + (e.key.toLowerCase() === 'arrowleft' ? -0.05 : 0.05))
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(digitTimer)
    }
  }, [])
}
