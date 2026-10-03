import { Plus } from 'lucide-react'
import { TenvyMark } from './TenvyMark'
import { useUI } from '../stores/ui'

export function FirstRun() {
  const { openAddSource } = useUI()
  return (
    <div className="grid flex-1 place-items-center bg-neutral-950">
      <div className="max-w-sm space-y-6 px-6 text-center animate-fade-in">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-neutral-800 to-neutral-950 shadow-lg shadow-black/40 ring-1 ring-white/10">
          <TenvyMark className="h-8 w-8 text-accent-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">Welcome to Tenvy</h1>
          <p className="mt-1.5 text-sm text-neutral-500">
            A lightweight IPTV player. Add a playlist to get started — M3U, Xtream Codes, or an XMLTV guide.
          </p>
        </div>
        <button
          onClick={openAddSource}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-accent-400 px-5 text-sm font-semibold text-neutral-950 shadow-sm transition-colors hover:bg-accent-300"
        >
          <Plus className="h-4 w-4" />
          Add your first playlist
        </button>
        <div className="flex items-center justify-center gap-2 text-[11px] text-neutral-600">
          <span>Works offline after first load</span>
          <span>·</span>
          <span>No telemetry</span>
        </div>
      </div>
    </div>
  )
}
