import { useUI } from '../stores/ui'
import { usePlayback } from '../stores/playback'
import { useIngest } from '../stores/ingest'
import { useParental } from '../stores/parental'
import { useUpdater } from '../stores/updater'

/**
 * True while any full-window overlay is open.
 *
 * The mpv surface is a native HWND that sits above the WebView2 composition,
 * so HTML can never draw on top of it. Any modal or drawer that overlaps the
 * video rect would be invisible (and unclickable) in that region. The Player
 * hides the native window while this is true and restores it afterwards;
 * playback itself keeps running.
 *
 * Add new overlays here — this is the single list the Player consults.
 */
export function useVideoObscured(): boolean {
  const ui = useUI((s) => s.searchOpen || s.settingsOpen || s.addSourceOpen || s.manageCategoriesOpen)
  const resume = usePlayback((s) => s.pendingResume !== null)
  const ingest = useIngest((s) => s.status !== null)
  const pin = useParental((s) => s.prompt !== null)
  const update = useUpdater((s) => s.prompt && (s.status.kind === 'available' || s.status.kind === 'downloading'))
  return ui || resume || ingest || pin || update
}
