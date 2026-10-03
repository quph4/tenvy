import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useIngest, type IngestStage } from '../stores/ingest'

/**
 * Fullscreen overlay shown while a playlist is being ingested. Blocks
 * pointer events so the user can't click anything else (especially not
 * trigger a second refresh, which would fight over the SQLite transaction).
 *
 * Rendered at the end of App so its z-index sits above modals like Settings
 * and AddSource; both of those call `useIngest.begin()` before invoking
 * their IPC, which immediately puts this overlay on top of them.
 */
export function IngestOverlay() {
  const { status } = useIngest()
  // Track elapsed seconds via setInterval so the UI doesn't look frozen
  // during the long "fetching" phase on a slow connection.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!status) return
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - status.startedAt) / 1000))
    }, 250)
    return () => window.clearInterval(id)
  }, [status])

  if (!status) return null

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 px-6 py-5 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-3">
          <Loader2 className="h-4 w-4 animate-spin text-accent-400" />
          <h3 className="text-sm font-semibold text-neutral-100">
            Loading {status.sourceName}
          </h3>
          <span className="ml-auto text-[11px] tabular-nums text-neutral-500">{elapsed}s</span>
        </div>

        <StageIndicator stage={status.stage} count={status.count} />

        <p className="mt-3 text-[11px] text-neutral-500">
          The UI is locked while we rewrite the local database. This usually
          takes a few seconds — large Xtream accounts with tens of thousands
          of VOD entries can run a bit longer.
        </p>
      </div>
    </div>
  )
}

const STAGE_ORDER: IngestStage[] = ['fetching', 'parsing', 'storing', 'done']
const STAGE_LABEL: Record<IngestStage, string> = {
  fetching: 'Fetching playlist',
  parsing: 'Parsing entries',
  storing: 'Writing to database',
  done: 'Done',
}

function StageIndicator({ stage, count }: { stage: IngestStage; count: number }) {
  const idx = STAGE_ORDER.indexOf(stage)
  return (
    <div className="mt-4 space-y-2">
      {STAGE_ORDER.slice(0, 3).map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'active' : 'pending'
        const showCount = s === 'storing' && state !== 'pending' && count > 0
        return (
          <div
            key={s}
            className="flex items-center gap-3 text-xs"
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span
              className={
                state === 'done'
                  ? 'h-1.5 w-1.5 rounded-full bg-emerald-400'
                  : state === 'active'
                    ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400'
                    : 'h-1.5 w-1.5 rounded-full bg-neutral-700'
              }
            />
            <span
              className={
                state === 'done'
                  ? 'text-neutral-300'
                  : state === 'active'
                    ? 'text-neutral-100'
                    : 'text-neutral-600'
              }
            >
              {STAGE_LABEL[s]}
            </span>
            {showCount && (
              <span className="ml-auto tabular-nums text-neutral-500">
                {count.toLocaleString()} entries
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
