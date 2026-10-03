import { useEffect } from 'react'
import { Topbar } from './components/Topbar'
import { Sidebar } from './components/Sidebar'
import { ChannelList } from './components/ChannelList'
import { Player } from './components/Player/Player'
import { EPGGrid } from './components/EPG/EPGGrid'
import { SearchPalette } from './components/Search/SearchPalette'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { AddSource } from './components/Settings/AddSource'
import { Toasts } from './components/Toasts'
import { FirstRun } from './components/FirstRun'
import { IngestOverlay } from './components/IngestOverlay'
import { ResumePrompt } from './components/ResumePrompt'
import { usePlaylist } from './stores/playlist'
import { useHistory } from './stores/history'
import { usePlayback } from './stores/playback'
import { useUI } from './stores/ui'
import { attachIngestListener } from './stores/ingest'
import { useKeyboardShortcuts } from './hooks/useKeyboard'

function App() {
  const { sources, hydrate } = usePlaylist()
  const { view } = useUI()
  const fullscreen = usePlayback((s) => s.fullscreen)

  useEffect(() => {
    hydrate().catch(() => {
      /* first run — no sources yet */
    })
    // Warm the progress map so the first paint of any channel list
    // already has badges/stripes. Failure is non-fatal — rows just
    // render without history adornments until the user plays something.
    useHistory
      .getState()
      .loadProgress()
      .catch(() => {})
  }, [hydrate])

  // Tauri emits `playlist-progress` events during ingest; the listener
  // keeps the ingest store in sync so IngestOverlay can render itself.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    attachIngestListener()
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {
        /* non-fatal — the overlay simply won't animate stage progress */
      })
    return () => {
      unlisten?.()
    }
  }, [])

  useKeyboardShortcuts()

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      {!fullscreen && <Topbar />}

      <main className="flex flex-1 overflow-hidden">
        {sources.length === 0 ? (
          <FirstRun />
        ) : view === 'epg' ? (
          <>
            {!fullscreen && <Sidebar />}
            <EPGGrid />
          </>
        ) : (
          <>
            {!fullscreen && <Sidebar />}
            {!fullscreen && <ChannelList />}
            <Player />
          </>
        )}
      </main>

      {!fullscreen && <footer className="flex h-7 items-center gap-3 border-t border-zinc-800/70 bg-zinc-950/80 px-4 text-[11px] text-zinc-500">
        <span>
          <span className="kbd mr-1">G</span>
          Guide
        </span>
        <span>
          <span className="kbd mr-1">Ctrl K</span>
          Search
        </span>
        <span>
          <span className="kbd mr-1">Space</span>
          Play
        </span>
        <span>
          <span className="kbd mr-1">F</span>
          Fullscreen
        </span>
        <span className="ml-auto tabular-nums text-zinc-600">Lumen · {__APP_VERSION__}</span>
      </footer>}

      <SearchPalette />
      <SettingsPanel />
      <AddSource />
      <Toasts />
      <IngestOverlay />
      <ResumePrompt />
    </div>
  )
}

export default App
