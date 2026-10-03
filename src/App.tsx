import { useEffect } from 'react'
import { Topbar } from './components/Topbar'
import { Sidebar } from './components/Sidebar'
import { ChannelList } from './components/ChannelList'
import { Library } from './components/Library/Library'
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
import { attachGuideListener } from './stores/nowPlaying'
import { startUpdateChecks } from './stores/updater'
import { useKeyboardShortcuts } from './hooks/useKeyboard'
import { subscribe } from './lib/ipc'

function App() {
  const { sources, hydrate, activeKind } = usePlaylist()
  const { view } = useUI()
  // Fullscreen and the mini player both show only the video.
  const mini = usePlayback((s) => s.mini)
  const chromeless = usePlayback((s) => s.fullscreen || s.mini)
  // Movies and series are browsed in the library; once one plays, the
  // player takes the whole width (with a way back to the library).
  const libraryTab = activeKind !== 'live'
  const watchingVod = usePlayback((s) => !!s.channel && s.channel.kind !== 'live')

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
  // Guides are downloaded in the background after an ingest; when one
  // lands, cached now-playing data is dropped so rows pick it up.
  useEffect(() => {
    const cleanups = [subscribe(attachIngestListener), subscribe(attachGuideListener)]
    return () => cleanups.forEach((fn) => fn())
  }, [])

  useEffect(() => startUpdateChecks(), [])

  useKeyboardShortcuts()

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      {!chromeless && <Topbar />}

      <main className="flex flex-1 overflow-hidden">
        {sources.length === 0 ? (
          <FirstRun />
        ) : view === 'epg' && !mini ? (
          <>
            {!chromeless && <Sidebar />}
            <EPGGrid />
          </>
        ) : libraryTab && !watchingVod && !mini ? (
          <>
            {!chromeless && <Sidebar />}
            <Library />
          </>
        ) : libraryTab ? (
          <Player />
        ) : (
          <>
            {!chromeless && <Sidebar />}
            {!chromeless && <ChannelList />}
            <Player />
          </>
        )}
      </main>

      {!chromeless && <footer className="flex h-7 items-center gap-3 border-t border-neutral-800/70 bg-neutral-950/80 px-4 text-[11px] text-neutral-500">
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
        <span>
          <span className="kbd mr-1">P</span>
          Mini player
        </span>
        <span className="ml-auto tabular-nums text-neutral-600">Tenvy · {__APP_VERSION__}</span>
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
