import { useEffect, useState } from 'react'
import { SkipForward } from 'lucide-react'
import { useUpNext } from '../../stores/upNext'

/** "Next episode in 7 s" with Play now / Cancel, while the countdown runs. */
export function UpNext({ compact = false }: { compact?: boolean }) {
  const startsAt = useUpNext((s) => s.startsAt)
  const label = useUpNext((s) => s.label)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (startsAt == null) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [startsAt])
  if (startsAt == null) return null
  const left = Math.max(0, Math.ceil((startsAt - now) / 1000))

  return (
    <div
      role="status"
      className={
        compact
          ? 'flex min-w-0 items-center gap-2'
          : 'flex shrink-0 items-center gap-3 border-t border-neutral-800/70 bg-neutral-900/95 px-5 py-2.5 text-sm'
      }
    >
      <SkipForward className="h-4 w-4 shrink-0 text-accent-400" />
      <span className="min-w-0 truncate text-neutral-200">
        Next episode in <span className="tabular-nums">{left}</span> s
        {label && <span className="text-neutral-500"> · {label}</span>}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          onClick={() => useUpNext.getState().playNow()}
          className="inline-flex h-7 items-center rounded-md bg-white px-3 text-xs font-semibold text-neutral-950 hover:bg-neutral-200"
        >
          Play now
        </button>
        <button
          onClick={() => useUpNext.getState().cancel()}
          className="inline-flex h-7 items-center rounded-md px-2.5 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
