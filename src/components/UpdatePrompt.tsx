import { ArrowDownToLine, Loader2 } from 'lucide-react'
import { usePlayback } from '../stores/playback'
import { useUpdater } from '../stores/updater'
import { TenvyMark } from './TenvyMark'

/**
 * "Tenvy x.y.z is available — Update now / Later". Waits until the viewer
 * leaves fullscreen or the mini player rather than interrupting.
 */
export function UpdatePrompt() {
  const { prompt, status, install, later } = useUpdater()
  const busyWatching = usePlayback((s) => s.fullscreen || s.mini)
  if (!prompt || busyWatching) return null
  if (status.kind !== 'available' && status.kind !== 'downloading') return null

  const downloading = status.kind === 'downloading'
  const notes = status.kind === 'available' ? status.notes : null

  return (
    <div className="fixed inset-0 z-[65] grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-neutral-800 to-neutral-950 ring-1 ring-white/10">
            <TenvyMark className="h-5 w-5 text-accent-400" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-white">Tenvy {status.version} is available</h2>
            <p className="text-xs text-neutral-500">You have {__APP_VERSION__}. Your library and settings are kept.</p>
          </div>
        </div>

        {notes && (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">What's new</div>
            <Notes text={notes} />
          </div>
        )}

        <div className="flex gap-2 border-t border-neutral-800 px-5 py-4">
          {downloading ? (
            <div className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-neutral-800 text-sm text-neutral-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              Downloading{status.progress != null ? ` ${Math.round(status.progress * 100)}%` : '…'} — Tenvy restarts when it's done
            </div>
          ) : (
            <>
              <button
                onClick={later}
                className="h-9 flex-1 rounded-lg border border-neutral-800 text-sm text-neutral-300 hover:border-neutral-700"
              >
                Later
              </button>
              <button
                onClick={() => install()}
                className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-accent-400 text-sm font-semibold text-neutral-950 hover:bg-accent-300"
              >
                <ArrowDownToLine className="h-4 w-4" />
                Update now
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** The changelog section from latest.json: headings and bullet points. */
function Notes({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  const out: React.ReactNode[] = []
  let bullet: string | null = null
  const flush = (key: number) => {
    if (bullet != null) out.push(<li key={`b${key}`} className="ml-4 list-disc">{bullet}</li>)
    bullet = null
  }
  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    if (/^#{1,6}\s/.test(line)) {
      flush(i)
      out.push(
        <div key={i} className="mt-3 text-xs font-semibold text-neutral-300 first:mt-0">
          {line.replace(/^#+\s*/, '')}
        </div>,
      )
    } else if (/^\s*[-*]\s/.test(line)) {
      flush(i)
      bullet = line.replace(/^\s*[-*]\s/, '')
    } else if (line.trim() && bullet != null) {
      bullet += ' ' + line.trim() // wrapped bullet text
    } else if (line.trim()) {
      flush(i)
      out.push(<p key={i} className="text-sm text-neutral-300">{line}</p>)
    }
  })
  flush(lines.length)
  return <ul className="space-y-1 text-sm leading-relaxed text-neutral-300">{out}</ul>
}
