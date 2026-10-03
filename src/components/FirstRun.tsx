import { CalendarClock, Check, Clapperboard, Search, Tv } from 'lucide-react'
import { useState } from 'react'
import { ipc } from '../lib/ipc'
import { usePlaylist } from '../stores/playlist'
import type { Source, SourceStats } from '../types'
import { SourceForm } from './Settings/SourceForm'
import { TenvyMark } from './TenvyMark'

const FEATURES = [
  { icon: Tv, text: 'Live TV with a full programme guide and catch-up' },
  { icon: Clapperboard, text: 'Movies and series with artwork, details and resume' },
  { icon: Search, text: 'Search everything, instantly' },
  { icon: CalendarClock, text: 'Reminders, favorites and watch history' },
]

/**
 * First launch: what Tenvy is, and connecting a provider. After the import
 * it shows what arrived, then hands over to the app.
 */
export function FirstRun() {
  const hydrate = usePlaylist((s) => s.hydrate)
  const [done, setDone] = useState<{ source: Source; stats: SourceStats | null } | null>(null)

  const onAdded = async (source: Source) => {
    const stats = await ipc.sourceStats(source.id).catch(() => null)
    setDone({ source, stats })
  }

  return (
    <div className="relative flex flex-1 overflow-y-auto bg-neutral-950">
      {/* A faint champagne glow behind the content. */}
      <div className="pointer-events-none absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-accent-400/10 blur-3xl" />

      <div className="relative mx-auto grid w-full max-w-5xl grid-cols-1 items-center gap-12 px-10 py-12 md:grid-cols-2">
        <div className="animate-fade-in">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-neutral-800 to-neutral-950 shadow-lg shadow-black/40 ring-1 ring-white/10">
            <TenvyMark className="h-8 w-8 text-accent-400" />
          </div>
          <h1 className="mt-6 text-4xl font-semibold leading-tight tracking-tight text-white">
            Your IPTV,
            <br />
            <span className="text-accent-300">beautifully</span> organised.
          </h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-neutral-400">
            Tenvy is a fast, modern player for the IPTV subscription you already have.
          </p>
          <ul className="mt-8 space-y-3">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-neutral-300">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-neutral-900 ring-1 ring-white/5">
                  <Icon className="h-4 w-4 text-accent-400" />
                </span>
                {text}
              </li>
            ))}
          </ul>
          <p className="mt-10 max-w-md text-xs leading-relaxed text-neutral-600">
            Tenvy is a player only. It doesn't include or sell any channels, movies or series — sign in with the
            details from your own IPTV provider.
          </p>
        </div>

        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/80 p-7 shadow-2xl shadow-black/50 backdrop-blur animate-fade-in">
          {done ? (
            <AllSet source={done.source} stats={done.stats} onStart={() => hydrate().catch(() => {})} />
          ) : (
            <>
              <h2 className="text-lg font-semibold text-white">Connect your provider</h2>
              <p className="mb-6 mt-1 text-sm text-neutral-500">
                Use the login or link your IPTV provider gave you.
              </p>
              <SourceForm allowGuide={false} onAdded={onAdded} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function AllSet({ source, stats, onStart }: { source: Source; stats: SourceStats | null; onStart(): void }) {
  const rows = stats
    ? [
        { label: 'Live channels', value: stats.live },
        { label: 'Movies', value: stats.movies },
        { label: 'Series', value: stats.series },
      ].filter((r) => r.value > 0)
    : []
  return (
    <div className="animate-fade-in">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-emerald-500/15">
        <Check className="h-5 w-5 text-emerald-400" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-white">You're all set</h2>
      <p className="mt-1 text-sm text-neutral-500">{source.name} is connected.</p>
      {rows.length > 0 && (
        <dl className="mt-6 grid grid-cols-3 gap-3">
          {rows.map((r) => (
            <div key={r.label} className="rounded-lg bg-neutral-950/70 p-3 ring-1 ring-white/5">
              <dt className="text-[11px] uppercase tracking-wider text-neutral-500">{r.label}</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-white">{r.value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-4 text-xs text-neutral-500">The programme guide keeps loading in the background.</p>
      <button
        onClick={onStart}
        className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg bg-accent-400 text-sm font-semibold text-neutral-950 hover:bg-accent-300"
      >
        Start watching
      </button>
    </div>
  )
}
