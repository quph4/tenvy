import { Pause, Play, Square, Tv } from 'lucide-react'
import { parseTitle } from '../lib/titles'
import { FAVORITES_GROUP, HISTORY_GROUP, usePlaylist } from '../stores/playlist'
import { usePlayback } from '../stores/playback'
import { useUI } from '../stores/ui'

/**
 * Shown whenever something plays while the player isn't on screen (Home,
 * the guide, the library). Nothing ever plays out of sight without it:
 * it says what's on, and offers Back to player, pause and Stop.
 */
export function NowPlayingBar() {
  const channel = usePlayback((s) => s.channel)
  const playing = usePlayback((s) => s.playing)
  if (!channel) return null

  const backToPlayer = () => {
    const pl = usePlaylist.getState()
    pl.select(null)
    const ownList = pl.activeGroup === FAVORITES_GROUP || pl.activeGroup === HISTORY_GROUP
    if (pl.activeKind !== channel.kind && !ownList) pl.setActiveKind(channel.kind).catch(() => {})
    useUI.getState().setView('player')
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-t border-neutral-800/70 bg-neutral-900/95 px-5 text-xs">
      <span className={playing ? 'h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-accent-400' : 'h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-600'} />
      <span className="text-neutral-500">{playing ? 'Now playing' : 'Paused'}</span>
      <span className="truncate font-medium text-neutral-200">{parseTitle(channel.name).title}</span>
      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={backToPlayer}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-neutral-200 hover:bg-neutral-800"
        >
          <Tv className="h-3.5 w-3.5" />
          Back to player
        </button>
        <button
          onClick={() => usePlayback.getState().setPlaying(!playing)}
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause' : 'Play'}
          className="grid h-7 w-7 place-items-center rounded-md text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={() => usePlayback.getState().stop()}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          <Square className="h-3 w-3" />
          Stop
        </button>
      </div>
    </div>
  )
}
