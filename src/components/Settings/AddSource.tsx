import { X } from 'lucide-react'
import { useUI } from '../../stores/ui'
import { usePlaylist } from '../../stores/playlist'
import { useToast } from '../../stores/toast'
import { SourceForm } from './SourceForm'

/** "Add playlist" dialog (from Settings). */
export function AddSource() {
  const { addSourceOpen, closeAddSource } = useUI()
  const hydrate = usePlaylist((s) => s.hydrate)
  const push = useToast((s) => s.push)

  if (!addSourceOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={closeAddSource}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">Add a playlist</h2>
          <button
            onClick={closeAddSource}
            className="grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="p-5">
          <SourceForm
            submitLabel="Add"
            onAdded={(source) => {
              push('success', `Added ${source.name}`)
              closeAddSource()
              hydrate().catch(() => {})
            }}
          />
        </div>
      </div>
    </div>
  )
}
