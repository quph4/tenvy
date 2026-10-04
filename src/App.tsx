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
import { Home } from './components/Home/Home'
import { PinPrompt } from './components/PinPrompt'
import { ChannelMenu } from './components/ChannelMenu'
import { UpdatePrompt } from './components/UpdatePrompt'
import { useUpdater } from './stores/updater'
import { ManageCategories } from './components/Settings/ManageCategories'
import { useAccounts } from './stores/accounts'
import { useParental } from './stores/parental'
import { IngestOverlay } from './components/IngestOverlay'
import { ResumePrompt } from './components/ResumePrompt'
import { usePlaylist } from './stores/playlist'
import { useHistory } from './stores/history'
import { usePlayback } from './stores/playback'
import { useUI } from './stores/ui'
import { attachIngestListener } from './stores/ingest'
import { attachGuideListener } from './stores/nowPlaying'
import { startUpdateChecks } from './stores/updater'
import { startReminderScheduler } from './stores/reminders'
import { openSupportLink, startAppInfo, useAppInfo } from './stores/appInfo'
import { useKeyboardShortcuts } from './hooks/useKeyboard'
import { ipc, subscribe } from './lib/ipc'
import { startToastMirror } from './lib/osd'
import { startAutoRefresh } from './stores/autoRefresh'
import { lastChannelId, useTvPrefs } from './stores/tvPrefs'
import { Heart } from 'lucide-react'
import { cn } from './lib/cn'

function App() {
  const { sources, hydrate, activeKind } = usePlaylist()
  const { view } = useUI()
  // Fullscreen and the mini player both show only the video.
  const mini = usePlayback((s) => s.mini)
  const videoOnly = usePlayback((s) => s.fullscreen || s.mini)
  // First run gets the whole window for the welcome page.
  const chromeless = videoOnly || sources.length === 0
  // Movies and series are browsed in the library; once one plays, the
  // player takes the whole width (with a way back to the library).
  const libraryTab = activeKind !== 'live'
  const watchingVod = usePlayback((s) => !!s.channel && s.channel.kind !== 'live')

  useEffect(() => {
    useParental.getState().refresh().catch(() => {})
    hydrate()
      .then(async () => {
        // Optionally pick up where the viewer left off, like a TV.
        const id = lastChannelId()
        if (!useTvPrefs.getState().startWithLastChannel || id == null) return
        const ch = await ipc.getChannel(id)
        if (ch && !usePlayback.getState().channel) usePlayback.getState().play(ch)
      })
      .catch(() => {
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
  useEffect(() => startReminderScheduler(), [])
  useEffect(() => startAppInfo(), [])
  // Subscription details for every provider, also one added just now.
  const sourceIds = sources.map((s) => s.id).join(',')
  useEffect(() => {
    if (sourceIds) useAccounts.getState().loadAll(usePlaylist.getState().sources).catch(() => {})
  }, [sourceIds])
  useEffect(() => startToastMirror(), [])
  useEffect(() => startAutoRefresh(), [])
  const support = useAppInfo((s) => s.info?.config.support ?? null)

  // Nothing plays where you can't see it. Going to Movies or Shows from
  // live TV stops the channel (otherwise its sound carries on behind the
  // library, holding the provider's connection) — the mini player is the
  // way to keep it on. And opening another title's page while a film
  // plays stops the film (its position is saved) so the page shows.
  const selected = usePlaylist((s) => s.selected)
  useEffect(() => {
    const pb = usePlayback.getState()
    if (activeKind !== 'live' && pb.channel?.kind === 'live' && !pb.mini) {
      pb.stop()
      ipc.mpvStop().catch(() => {})
    }
  }, [activeKind])
  useEffect(() => {
    const pb = usePlayback.getState()
    if (selected && pb.channel && pb.channel.kind !== 'live' && !pb.mini) {
      pb.stop()
      ipc.mpvStop().catch(() => {})
    }
  }, [selected])

  useKeyboardShortcuts()

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      {!chromeless && <Topbar />}

      <main className="flex flex-1 overflow-hidden">
        {sources.length === 0 ? (
          <FirstRun />
        ) : view === 'home' && !mini ? (
          <Home />
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
        <span>
          <span className="kbd mr-1">0–9</span>
          Channel
        </span>
        {support && (
          <button
            onClick={openSupportLink}
            className="ml-auto inline-flex items-center gap-1 text-neutral-500 transition-colors hover:text-accent-300"
          >
            <Heart className="h-3 w-3" />
            {support.label ?? 'Support Tenvy'}
          </button>
        )}
        <button
          onClick={() => useUpdater.getState().checkForUpdates(true)}
          title="Check for updates"
          className={cn('tabular-nums text-neutral-600 hover:text-neutral-300', !support && 'ml-auto')}
        >
          Tenvy · {__APP_VERSION__}
        </button>
      </footer>}

      <SearchPalette />
      <SettingsPanel />
      <AddSource />
      <ManageCategories />
      <PinPrompt />
      <ChannelMenu />
      <UpdatePrompt />
      <Toasts />
      <IngestOverlay />
      <ResumePrompt />
    </div>
  )
}

export default App
