import { CalendarDays, ChevronLeft, ChevronRight, Clapperboard, MonitorPlay, Tv, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import { hhmm } from '../../lib/time'
import { parseTitle } from '../../lib/titles'
import { daysLeft, expiryLabel, useAccounts } from '../../stores/accounts'
import { isResumable, useHistory } from '../../stores/history'
import { useNowPlaying } from '../../stores/nowPlaying'
import { useParental } from '../../stores/parental'
import { usePlayback } from '../../stores/playback'
import { usePlaylist } from '../../stores/playlist'
import { useUI } from '../../stores/ui'
import type { Channel, HistoryEntry } from '../../types'
import { Poster } from '../Library/Poster'

interface HomeData {
  history: HistoryEntry[]
  favorites: Channel[]
  movies: Channel[]
  series: Channel[]
}

/**
 * The start screen: pick up where you left off, your channels, and
 * what's new — instead of dropping straight into a 25 000-row list.
 */
export function Home() {
  const [data, setData] = useState<HomeData | null>(null)
  const unlocked = useParental((s) => s.status.unlocked)
  const sources = usePlaylist((s) => s.sources)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      ipc.listHistory().catch(() => []),
      ipc.listFavorites().catch(() => []),
      ipc.recentlyAdded('movie', 24).catch(() => []),
      ipc.recentlyAdded('series', 24).catch(() => []),
    ]).then(([history, favorites, movies, series]) => {
      if (!cancelled) setData({ history, favorites, movies, series })
    })
    return () => {
      cancelled = true
    }
  }, [unlocked, sources])

  const continueWatching = (data?.history ?? []).filter((h) => h.channel.kind !== 'live' && isResumable({ ...h, channelId: h.channel.id }))
  const recentChannels = dedupe((data?.history ?? []).filter((h) => h.channel.kind === 'live').map((h) => h.channel)).slice(0, 16)
  const favChannels = (data?.favorites ?? []).filter((c) => c.kind === 'live')
  const favVod = (data?.favorites ?? []).filter((c) => c.kind !== 'live')
  const empty = data && !continueWatching.length && !recentChannels.length && !data.favorites.length

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1600px] px-8 pb-16 pt-8">
        <Header />
        {empty && <QuickStart />}
        {continueWatching.length > 0 && (
          <Row title="Continue watching">
            {continueWatching.map((h) => (
              <PosterTile key={h.channel.id} channel={h.channel} progress={h.timePos / h.duration} onClick={() => usePlayback.getState().requestPlay(h.channel)} />
            ))}
          </Row>
        )}
        {recentChannels.length > 0 && (
          <Row title="Recently watched">
            {recentChannels.map((c) => <ChannelTile key={c.id} channel={c} />)}
          </Row>
        )}
        {favChannels.length > 0 && (
          <Row title="Favorite channels">
            {favChannels.map((c) => <ChannelTile key={c.id} channel={c} />)}
          </Row>
        )}
        {favVod.length > 0 && (
          <Row title="Favorite films & series">
            {favVod.map((c) => <PosterTile key={c.id} channel={c} onClick={() => openDetails(c)} />)}
          </Row>
        )}
        {(data?.movies.length ?? 0) > 0 && (
          <Row title="New movies">
            {data!.movies.map((c) => <PosterTile key={c.id} channel={c} onClick={() => openDetails(c)} />)}
          </Row>
        )}
        {(data?.series.length ?? 0) > 0 && (
          <Row title="New series">
            {data!.series.map((c) => <PosterTile key={c.id} channel={c} onClick={() => openDetails(c)} />)}
          </Row>
        )}
      </div>
    </div>
  )
}

function openDetails(c: Channel) {
  useUI.getState().setView('player')
  usePlaylist.getState().openDetails(c).catch(() => {})
}

function dedupe(list: Channel[]): Channel[] {
  const seen = new Set<number>()
  return list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** Greeting plus the subscription's status, with a warning near expiry. */
function Header() {
  const sources = usePlaylist((s) => s.sources)
  const accounts = useAccounts((s) => s.bySource)
  const withInfo = sources.filter((s) => accounts[s.id])
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">{greeting()}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {withInfo.map((s) => {
          const info = accounts[s.id]!
          const left = daysLeft(info)
          const warn = left != null && left <= 14
          return (
            <div
              key={s.id}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
                warn ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-neutral-800 bg-neutral-900/60 text-neutral-400',
              )}
            >
              {warn ? <TriangleAlert className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
              <span className="font-medium text-neutral-200">{s.name}</span>
              <span>{expiryLabel(info)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function QuickStart() {
  const go = (kind: 'live' | 'movie' | 'series', view: 'player' | 'epg' = 'player') => {
    usePlaylist.getState().setActiveKind(kind).catch(() => {})
    useUI.getState().setView(view)
  }
  const items = [
    { icon: Tv, label: 'Live TV', hint: 'Browse channels', run: () => go('live') },
    { icon: CalendarDays, label: 'TV guide', hint: "What's on now and later", run: () => go('live', 'epg') },
    { icon: Clapperboard, label: 'Movies', hint: 'Your film library', run: () => go('movie') },
    { icon: MonitorPlay, label: 'Series', hint: 'Seasons and episodes', run: () => go('series') },
  ]
  return (
    <div className="mb-10">
      <p className="mb-4 text-sm text-neutral-400">Start watching — what you watch and favorite shows up here.</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map(({ icon: Icon, label, hint, run }) => (
          <button
            key={label}
            onClick={run}
            className="group flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-left transition-colors hover:border-accent-500/40 hover:bg-neutral-900"
          >
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-accent-400/10 text-accent-400">
              <Icon className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-neutral-100">{label}</span>
              <span className="block text-xs text-neutral-500">{hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** A titled, horizontally scrolling row with arrow buttons. */
function Row({ title, children }: { title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' })
  return (
    <section className="group/row mb-9">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-neutral-100">{title}</h2>
        <div className="flex gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
          <ArrowButton onClick={() => scroll(-1)} label="Scroll left"><ChevronLeft className="h-4 w-4" /></ArrowButton>
          <ArrowButton onClick={() => scroll(1)} label="Scroll right"><ChevronRight className="h-4 w-4" /></ArrowButton>
        </div>
      </div>
      <div ref={ref} className="no-scrollbar -mx-1 flex gap-4 overflow-x-auto scroll-smooth px-1 pb-2">
        {children}
      </div>
    </section>
  )
}

function ArrowButton({ children, onClick, label }: { children: React.ReactNode; onClick(): void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} className="grid h-7 w-7 place-items-center rounded-md border border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200">
      {children}
    </button>
  )
}

/** Live channel: logo, name and what's on, with how far along it is. */
function ChannelTile({ channel }: { channel: Channel }) {
  const now = useNowPlaying(channel.tvgId)
  const t = Date.now() / 1000
  const pct = now ? Math.min(100, Math.max(0, ((t - now.start) / (now.stop - now.start)) * 100)) : 0
  return (
    <button
      onClick={() => usePlayback.getState().play(channel)}
      className="group relative flex w-64 shrink-0 items-center gap-3 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60 p-3 text-left transition-colors hover:border-accent-500/40 hover:bg-neutral-900"
    >
      <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-neutral-950 ring-1 ring-white/5">
        {channel.logo ? (
          <img src={channel.logo} alt="" referrerPolicy="no-referrer" className="h-full w-full object-contain p-1" />
        ) : (
          <Tv className="h-5 w-5 text-neutral-600" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-neutral-100">{channel.name}</span>
        <span className="block truncate text-xs text-neutral-500">
          {now ? `${now.title} · until ${hhmm(now.stop)}` : 'Live'}
        </span>
      </span>
      {now && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-neutral-800">
          <span className="block h-full bg-accent-400/80" style={{ width: `${pct}%` }} />
        </span>
      )}
    </button>
  )
}

/** Movie, series or episode poster with an optional progress bar. */
function PosterTile({ channel, progress, onClick }: { channel: Channel; progress?: number; onClick(): void }) {
  const live = useHistory((s) => s.progress.get(channel.id))
  const pct = progress ?? (isResumable(live) ? live.timePos / live.duration : undefined)
  const { title, year } = parseTitle(channel.name)
  const episode = channel.season != null && channel.episode != null ? `S${channel.season} · E${channel.episode}` : null
  return (
    <button onClick={onClick} className="group w-36 shrink-0 text-left">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/5 transition-transform group-hover:-translate-y-0.5 group-hover:ring-accent-500/40">
        <Poster src={channel.logo} title={title} />
        {pct != null && (
          <span className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <span className="block h-full bg-accent-400" style={{ width: `${Math.max(2, pct * 100)}%` }} />
          </span>
        )}
      </div>
      <div className="mt-2 truncate text-sm text-neutral-200">{title}</div>
      <div className="truncate text-xs text-neutral-500">
        {episode ?? [year ?? channel.year, channel.rating ? `★ ${channel.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')}
      </div>
    </button>
  )
}
