import { Plus } from 'lucide-react'
import { QanalMark } from './QanalMark'
import { useUI } from '../stores/ui'

export function FirstRun() {
  const { openAddSource } = useUI()
  return (
    <div className="grid flex-1 place-items-center bg-zinc-950">
      <div className="max-w-sm space-y-6 px-6 text-center animate-fade-in">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-400 to-indigo-600 shadow-lg shadow-indigo-500/20">
          <QanalMark className="h-8 w-8 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Welcome to Qanal</h1>
          <p className="mt-1.5 text-sm text-zinc-500">
            A lightweight IPTV player. Add a playlist to get started — M3U, Xtream Codes, or an XMLTV guide.
          </p>
        </div>
        <button
          onClick={openAddSource}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-indigo-500 px-5 text-sm font-semibold text-zinc-950 shadow-sm transition-colors hover:bg-indigo-400"
        >
          <Plus className="h-4 w-4" />
          Add your first playlist
        </button>
        <div className="flex items-center justify-center gap-2 text-[11px] text-zinc-600">
          <span>Works offline after first load</span>
          <span>·</span>
          <span>No telemetry</span>
        </div>
      </div>
    </div>
  )
}
