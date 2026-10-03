import { Bell, BellOff, History, Play, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DAY, hhmm, weekday } from '../../lib/time'
import { useReminders } from '../../stores/reminders'
import { useToast } from '../../stores/toast'
import type { Channel, Programme } from '../../types'

/**
 * What a guide programme can do, depending on when it is:
 *   on now   → Watch, Start over (with catch-up)
 *   aired    → Watch via catch-up, when the archive reaches back that far
 *   upcoming → Remind me, or watch the channel now
 */
export function ProgrammeCard({
  channel,
  programme: p,
  onClose,
  onWatchLive,
  onCatchUp,
}: {
  channel: Channel
  programme: Programme
  onClose(): void
  onWatchLive(): void
  onCatchUp(): void
}) {
  const now = Math.floor(Date.now() / 1000)
  const isNow = p.start <= now && now < p.stop
  const isPast = p.stop <= now
  const archived =
    !!channel.archiveDays && p.start < now && p.start >= now - channel.archiveDays * DAY
  const reminded = useReminders((s) => s.items.some((r) => r.channel.id === channel.id && r.start === p.start))
  const push = useToast((s) => s.push)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Capture phase, and stop there: Escape closes the card only, not the
    // guide behind it (the global shortcut would leave the guide too).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const toggleReminder = async () => {
    setBusy(true)
    try {
      const on = await useReminders.getState().toggle(channel, p)
      push('success', on ? `We'll remind you at ${hhmm(p.start)}` : 'Reminder removed')
    } catch (e) {
      push('error', String(e))
    } finally {
      setBusy(false)
    }
  }

  const minutes = Math.round((p.stop - p.start) / 60)
  const primary =
    'inline-flex h-9 items-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-neutral-950 hover:bg-neutral-200'
  const secondary =
    'inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-700 px-3.5 text-sm text-neutral-200 hover:border-neutral-500'

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              {channel.name} · {weekday(p.start)} {hhmm(p.start)} – {hhmm(p.stop)} · {minutes} min
            </div>
            <h2 className="mt-1.5 text-xl font-semibold text-white">{p.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isNow && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full bg-accent-400"
              style={{ width: `${Math.min(100, ((now - p.start) / (p.stop - p.start)) * 100)}%` }}
            />
          </div>
        )}

        {p.description && (
          <p className="mt-4 line-clamp-6 text-sm leading-relaxed text-neutral-300">{p.description}</p>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          {isNow && (
            <>
              <button onClick={onWatchLive} className={primary}>
                <Play className="h-4 w-4 fill-current" /> Watch
              </button>
              {archived && (
                <button onClick={onCatchUp} className={secondary}>
                  <RotateCcw className="h-4 w-4" /> Start over
                </button>
              )}
            </>
          )}
          {isPast &&
            (archived ? (
              <button onClick={onCatchUp} className={primary}>
                <History className="h-4 w-4" /> Watch (catch-up)
              </button>
            ) : (
              <span className="text-sm text-neutral-500">
                This programme has aired{channel.archiveDays ? ' and is older than the archive' : ''}.
              </span>
            ))}
          {!isNow && !isPast && (
            <>
              <button onClick={toggleReminder} disabled={busy} className={reminded ? secondary : primary}>
                {reminded ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                {reminded ? 'Remove reminder' : 'Remind me'}
              </button>
              <button onClick={onWatchLive} className={secondary}>
                <Play className="h-4 w-4" /> Watch {channel.name} now
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
