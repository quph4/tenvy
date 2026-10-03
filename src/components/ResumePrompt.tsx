import { useEffect } from 'react'
import { Play, RotateCcw } from 'lucide-react'
import { usePlayback } from '../stores/playback'
import { fmtResume } from '../stores/history'

/**
 * "Resume where you left off, or start from the beginning?" — the prompt
 * that fires when the user clicks a movie/episode with a saved position.
 *
 * Driven by `usePlayback.pendingResume`. Row clicks call `requestPlay`,
 * which sets that field when a resumable position exists; we intercept
 * here and let the user resolve it. Pressing Enter resumes (the more
 * common intent); Escape cancels (treats the click as a miss).
 */
export function ResumePrompt() {
  const pending = usePlayback((s) => s.pendingResume)
  const resolve = usePlayback((s) => s.resolveResume)
  const cancel = usePlayback((s) => s.cancelResume)

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        resolve(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, resolve, cancel])

  if (!pending) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm animate-fade-in"
      onClick={cancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-950/95 p-6 shadow-2xl shadow-black/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[10px] font-semibold uppercase tracking-wider text-accent-400">
          Pick up where you left off?
        </div>
        <div className="mt-2 truncate text-base font-medium text-neutral-100">
          {pending.channel.name}
        </div>
        <div className="mt-1 text-xs text-neutral-500">
          Last watched at {fmtResume(pending.savedSeconds)}
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <button
            autoFocus
            onClick={() => resolve(false)}
            className="flex items-center gap-3 rounded-md bg-accent-400 px-3 py-2.5 text-left text-sm font-semibold text-neutral-950 transition-colors hover:bg-accent-300"
          >
            <Play className="h-4 w-4" />
            <span className="flex-1">Resume</span>
            <span className="text-xs tabular-nums text-neutral-950/60">
              {fmtResume(pending.savedSeconds)}
            </span>
          </button>
          <button
            onClick={() => resolve(true)}
            className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-left text-sm text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900"
          >
            <RotateCcw className="h-4 w-4 text-neutral-500" />
            <span className="flex-1">Start from beginning</span>
          </button>
        </div>

        <div className="mt-4 text-[11px] text-neutral-600">
          <span className="kbd mr-1">Enter</span> Resume ·
          <span className="kbd mx-1">Esc</span> Cancel
        </div>
      </div>
    </div>
  )
}
