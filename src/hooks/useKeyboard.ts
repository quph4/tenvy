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
 *   ↑ / ↓    prev/next channel (live, player view)
 *   ← / →    volume down/up
 *
 * State is read with `getState()` at key time rather than subscribed to:
 * this hook lives in App, and subscribing to the playback store would
 * re-render the whole tree on every position tick during playback.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
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
        if (ui.searchOpen || ui.addSourceOpen || ui.settingsOpen) return // those handle their own escape
        if (pb.pendingResume) return // ResumePrompt handles its own escape
        if (pb.fullscreen) pb.setFullscreen(false)
        else if (ui.view === 'epg') ui.setView('player')
        return
      }

      if (typing) return

      switch (e.key.toLowerCase()) {
        case 'g':
          e.preventDefault()
          ui.setView(ui.view === 'epg' ? 'player' : 'epg')
          break
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
        case 'm':
          if (!channel) return
          e.preventDefault()
          pb.toggleMute()
          break
        case 'x': {
          if (!channel) return
          e.preventDefault()
          // Prefer what mpv is *actually* playing right now so in-app
          // picks carry over to the external launch. Fall back to the
          // saved preference if mpv hasn't reported tracks yet.
          const audioTrack = pb.currentAudio ?? pb.preferredAudioTrack
          const subtitleTrack = pb.currentSubtitle ?? pb.preferredSubtitleTrack
          const { push } = useToast.getState()
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
          const { timePos, duration } = pb
          if (timePos == null || duration == null || duration <= 0) return
          e.preventDefault()
          const delta = e.key.toLowerCase() === 'j' ? -10 : 10
          ipc.mpvSeek(Math.max(0, Math.min(duration, timePos + delta))).catch(() => {})
          break
        }
        case 'arrowup':
        case 'arrowdown': {
          // Channel zapping only makes sense for live TV in the player
          // view; in the guide the arrows should scroll.
          if (!channel || channel.kind !== 'live' || ui.view !== 'player') return
          const { channels } = usePlaylist.getState()
          if (channels.length === 0) return
          e.preventDefault()
          const i = channels.findIndex((c) => c.id === channel.id)
          const step = e.key.toLowerCase() === 'arrowup' ? -1 : 1
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
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
