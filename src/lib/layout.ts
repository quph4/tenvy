import { usePlayback } from '../stores/playback'
import { usePlaylist } from '../stores/playlist'
import { useUI } from '../stores/ui'

/**
 * Whether the player (video and controls) is on screen right now — the
 * same rule App uses to pick its layout. Playback keys only act when it
 * is; otherwise something plays behind Home, the guide or the library and
 * the Now playing bar is the way to control it.
 */
export function isPlayerShown(): boolean {
  const pb = usePlayback.getState()
  if (pb.mini || pb.fullscreen) return true
  const pl = usePlaylist.getState()
  if (pl.sources.length === 0) return false
  const view = useUI.getState().view
  if (view === 'home' || view === 'epg') return false
  const libraryTab = pl.activeKind !== 'live'
  const watchingVod = !!pb.channel && pb.channel.kind !== 'live'
  return !(libraryTab && !watchingVod)
}
