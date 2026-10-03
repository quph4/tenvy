import { Plus, RefreshCcw, Trash2, X } from 'lucide-react'
import { useUI } from '../../stores/ui'
import { usePlaylist } from '../../stores/playlist'
import { useIngest } from '../../stores/ingest'
import { ipc } from '../../lib/ipc'
import { useToast } from '../../stores/toast'
import { useUpdater } from '../../stores/updater'

export function SettingsPanel() {
  const { settingsOpen, toggleSettings, openAddSource } = useUI()
  const { sources, hydrate } = usePlaylist()
  const { push } = useToast()

  if (!settingsOpen) return null

  const refresh = async (id: number, name: string) => {
    // Flip the ingest overlay up immediately — the first `fetching` event
    // from Rust can take a second on slow links, and we want the UI locked
    // the moment the click happens.
    useIngest.getState().begin(id, name)
    try {
      await ipc.refreshSource(id)
      push('success', `Refreshed ${name}`)
      await hydrate()
    } catch (e) {
      push('error', String(e))
    } finally {
      // If Rust threw before emitting `done`, we still need to clear the
      // overlay ourselves.
      useIngest.getState().end()
    }
  }

  const remove = async (id: number) => {
    try {
      await ipc.removeSource(id)
      await hydrate()
    } catch (e) {
      push('error', String(e))
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-end bg-black/50 animate-fade-in" onClick={toggleSettings}>
      <aside
        className="flex h-full w-96 flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={toggleSettings}
            className="grid h-6 w-6 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Playlists
            </span>
            <button
              onClick={openAddSource}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-indigo-500 px-2.5 text-xs font-semibold text-zinc-950 hover:bg-indigo-400"
            >
              <Plus className="h-3 w-3" />
              Add
            </button>
          </div>

          {sources.length === 0 && (
            <div className="rounded-md border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No playlists yet. Add one to get started.
            </div>
          )}

          <ul className="space-y-1.5">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-zinc-200">{s.name}</div>
                  <div className="truncate text-[11px] text-zinc-500">
                    {s.kind.toUpperCase()} · {new URL(s.url.startsWith('http') ? s.url : 'file://' + s.url).hostname || s.url}
                  </div>
                </div>
                <button
                  onClick={() => refresh(s.id, s.name)}
                  className="grid h-7 w-7 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label="Refresh"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => remove(s.id)}
                  className="grid h-7 w-7 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                  aria-label="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <AboutSection />
      </aside>
    </div>
  )
}

function AboutSection() {
  const status = useUpdater((s) => s.status)
  const checkForUpdates = useUpdater((s) => s.checkForUpdates)
  const install = useUpdater((s) => s.install)

  const line =
    status.kind === 'checking'
      ? 'Checking for updates…'
      : status.kind === 'none'
        ? "You're on the latest version."
        : status.kind === 'available'
          ? `Version ${status.version} is available.`
          : status.kind === 'downloading'
            ? `Downloading ${status.version}…`
            : status.kind === 'error'
              ? `Couldn't check for updates: ${status.message}`
              : null

  return (
    <div className="border-t border-zinc-800 p-5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">About</span>
      <div className="mt-2 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-zinc-200">Tenvy {__APP_VERSION__}</div>
          {line && <div className="mt-0.5 text-[11px] text-zinc-500">{line}</div>}
        </div>
        {status.kind === 'available' ? (
          <button
            onClick={() => install()}
            className="inline-flex h-7 items-center rounded-md bg-indigo-500 px-2.5 text-xs font-semibold text-zinc-950 hover:bg-indigo-400"
          >
            Install
          </button>
        ) : (
          <button
            onClick={() => checkForUpdates(true)}
            disabled={status.kind === 'checking' || status.kind === 'downloading'}
            className="inline-flex h-7 items-center rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-300 hover:border-zinc-700 disabled:opacity-50"
          >
            Check for updates
          </button>
        )}
      </div>
    </div>
  )
}
