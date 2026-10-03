import { useEffect } from 'react'
import { usePlayback } from '../stores/playback'
import { usePlaylist } from '../stores/playlist'
import { useUI } from '../stores/ui'
import { useToast } from '../stores/toast'
import { ipc } from '../lib/ipc'

/**
 * Global keyboard shortcuts. Mounted once from App.
 *
 *   Ctrl+K   open search
 *   G        toggle EPG grid view
 *   Esc      close overlays
 *   Space    play/pause (when not typing)
 *   F        fullscreen
 *   M        mute
 *   X        open current channel in external player (mpv / VLC)
 *   J / L    seek -10s / +10s (VOD only)
 *   ↑ / ↓    prev/next channel
 *   ← / →    volume down/up
 */
export function useKeyboardShortcuts() {
  const { searchOpen, addSourceOpen, settingsOpen, closeSearch, openSearch, setView, view } = useUI()
  const { channel, setVolume, toggleMute, volume, setPlaying, playing } = usePlayback()
  const { channels } = usePlaylist()
  const { push } = useToast()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      // Global — work even while typing
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchOpen ? closeSearch() : openSearch()
        return
      }
      if (e.key === 'Escape') {
        if (searchOpen || addSourceOpen || settingsOpen) return // those handle their own escape
        if (view === 'epg') setView('player')
        return
      }

      if (typing) return

      switch (e.key.toLowerCase()) {
        case 'g':
          e.preventDefault()
          setView(view === 'epg' ? 'player' : 'epg')
          break
        case ' ':
          if (!channel) return
          e.preventDefault()
          setPlaying(!playing)
          break
        case 'm':
          if (!channel) return
          e.preventDefault()
          toggleMute()
          break
        case 'x': {
          if (!channel) return
          e.preventDefault()
          // Prefer what mpv is *actually* playing right now so in-app
          // picks carry over to the external launch. Fall back to the
          // saved preference if mpv hasn't reported tracks yet.
          const s = usePlayback.getState()
          const audioTrack = s.currentAudio ?? s.preferredAudioTrack
          const subtitleTrack = s.currentSubtitle ?? s.preferredSubtitleTrack
          ipc
            .openExternal(channel.streamUrl, { audioTrack, subtitleTrack })
            .then((p) => push('success', `Launched ${p.split(/[\\/]/).pop() ?? p}`))
            .catch((err) => push('error', String(err)))
          break
        }
        case 'j':
        case 'l': {
          // ±10s relative seek via mpv. Live streams still accept a seek
          // but it's a no-op inside their tiny buffer — no need to guard.
          if (!channel) return
          const { timePos, duration } = usePlayback.getState()
          if (timePos == null || duration == null || duration <= 0) return
          e.preventDefault()
          const delta = e.key.toLowerCase() === 'j' ? -10 : 10
          ipc.mpvSeek(Math.max(0, Math.min(duration, timePos + delta))).catch(() => {})
          break
        }
        case 'arrowup': {
          if (!channel || channels.length === 0) return
          e.preventDefault()
          const i = channels.findIndex((c) => c.id === channel.id)
          const prev = channels[(i - 1 + channels.length) % channels.length]
          usePlayback.getState().play(prev)
          break
        }
        case 'arrowdown': {
          if (!channel || channels.length === 0) return
          e.preventDefault()
          const i = channels.findIndex((c) => c.id === channel.id)
          const next = channels[(i + 1) % channels.length]
          usePlayback.getState().play(next)
          break
        }
        case 'arrowleft':
          e.preventDefault()
          setVolume(volume - 0.05)
          break
        case 'arrowright':
          e.preventDefault()
          setVolume(volume + 0.05)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    channel,
    channels,
    searchOpen,
    addSourceOpen,
    settingsOpen,
    view,
    playing,
    volume,
    closeSearch,
    openSearch,
    setView,
    setPlaying,
    setVolume,
    toggleMute,
    push,
  ])
}
