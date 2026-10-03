import { ArrowLeft, Clapperboard, Play, RotateCcw, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import { parseTitle } from '../../lib/titles'
import { toEpisode, type Episode, type LibraryItem } from '../../lib/series'
import { fmtResume, isResumable, useHistory } from '../../stores/history'
import { usePlayback } from '../../stores/playback'
import { useToast } from '../../stores/toast'
import type { Channel, HistoryProgress, VodDetails } from '../../types'
import { ProgressStripe } from '../ChannelList'
import { Poster } from './Poster'

/**
 * A movie or series page: artwork, the facts, and how to start watching.
 * Series list their seasons and episodes underneath.
 */
export function Details({ item, onBack }: { item: LibraryItem; onBack(): void }) {
  const channel = item.type === 'movie' ? item.channel : item.show.container
  const name = item.type === 'movie' ? item.channel.name : item.show.name
  const { title, tags, year: titleYear } = parseTitle(name)
  const details = useDetails(channel)
  const poster = details.data?.poster ?? (item.type === 'movie' ? item.channel.logo : item.show.logo)
  const year = channel?.year ?? yearOf(details.data?.releaseDate) ?? titleYear
  const rating = details.data?.rating ?? channel?.rating ?? null

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto bg-neutral-950">
      {/* Backdrop: the artwork fades into the page. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden">
        {details.data?.backdrop && (
          <img
            src={details.data.backdrop}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover opacity-40 animate-fade-in"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-neutral-950/40 via-neutral-950/70 to-neutral-950" />
        <div className="absolute inset-0 bg-gradient-to-r from-neutral-950/80 to-transparent" />
      </div>

      <div className="relative px-8 pb-10 pt-5">
        <button
          onClick={onBack}
          className="mb-6 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-neutral-300 hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <div className="flex gap-8">
          <div className="w-48 shrink-0">
            <div className="aspect-[2/3] overflow-hidden rounded-xl bg-neutral-900 shadow-2xl shadow-black/60 ring-1 ring-white/10">
              <Poster src={poster} title={title} />
            </div>
          </div>

          <div className="min-w-0 flex-1 pt-2">
            <h1 className="text-3xl font-semibold tracking-tight text-white">{title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-400">
              {year && <span>{year}</span>}
              {details.data?.duration && <span>{details.data.duration}</span>}
              {rating ? (
                <span className="inline-flex items-center gap-1 text-accent-300">
                  <Star className="h-3.5 w-3.5 fill-current" />
                  {rating.toFixed(1)}
                </span>
              ) : null}
              {details.data?.genre && <span>{details.data.genre}</span>}
              {tags.map((t) => (
                <span key={t} className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                  {t}
                </span>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2">
              {/* Series get their "continue" button with the episode list. */}
              {item.type === 'movie' && <MovieActions channel={item.channel} />}
              {channel && <FavoriteButton channel={channel} />}
              {details.data?.trailer && (
                <button
                  onClick={() => openUrl(details.data!.trailer!).catch(() => {})}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900/60 px-4 text-sm text-neutral-200 hover:border-neutral-500"
                >
                  <Clapperboard className="h-4 w-4" />
                  Trailer
                </button>
              )}
            </div>

            {details.loading && !details.data && (
              <div className="mt-6 max-w-2xl space-y-2">
                <div className="h-3 w-full animate-pulse rounded bg-neutral-800/80" />
                <div className="h-3 w-5/6 animate-pulse rounded bg-neutral-800/80" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-800/80" />
              </div>
            )}
            {details.data?.plot && (
              <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-neutral-300">{details.data.plot}</p>
            )}
            <dl className="mt-5 max-w-2xl space-y-1.5 text-sm">
              {details.data?.cast && <Fact label="Cast" value={details.data.cast} />}
              {details.data?.director && <Fact label="Director" value={details.data.director} />}
            </dl>
          </div>
        </div>

        {item.type === 'show' && <Seasons item={item} />}
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-neutral-500">{label}</dt>
      <dd className="line-clamp-2 text-neutral-300">{value}</dd>
    </div>
  )
}

// -------- data --------

const detailsCache = new Map<number, VodDetails>()

/** Details for a movie or series container; null channel = nothing to fetch. */
function useDetails(channel: Channel | null) {
  const id = channel?.id ?? null
  const [state, setState] = useState<{ id: number | null; data: VodDetails | null; loading: boolean }>(() => ({
    id,
    data: id !== null ? detailsCache.get(id) ?? null : null,
    loading: id !== null && !detailsCache.has(id),
  }))

  useEffect(() => {
    if (id === null) return
    const cached = detailsCache.get(id)
    if (cached) {
      setState({ id, data: cached, loading: false })
      return
    }
    let cancelled = false
    setState({ id, data: null, loading: true })
    ipc
      .vodDetails(id)
      .then((d) => {
        detailsCache.set(id, d)
        if (!cancelled) setState({ id, data: d, loading: false })
      })
      .catch(() => {
        if (!cancelled) setState({ id, data: null, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [id])

  return state.id === id ? state : { id, data: null, loading: id !== null }
}

/** Episodes of a show: fetched for provider series, grouped ones are local. */
function useEpisodes(item: Extract<LibraryItem, { type: 'show' }>) {
  const container = item.show.container
  const [state, setState] = useState<{ episodes: Episode[]; loading: boolean; error: string | null }>({
    episodes: container ? [] : item.show.episodes,
    loading: !!container,
    error: null,
  })
  useEffect(() => {
    if (!container) {
      setState({ episodes: item.show.episodes, loading: false, error: null })
      return
    }
    let cancelled = false
    setState({ episodes: [], loading: true, error: null })
    ipc
      .listEpisodes(container.id)
      .then((rows) => !cancelled && setState({ episodes: rows.map(toEpisode), loading: false, error: null }))
      .catch((e) => !cancelled && setState({ episodes: [], loading: false, error: String(e).replace(/^Error:\s*/, '') }))
    return () => {
      cancelled = true
    }
  }, [container, item.show.episodes])
  return state
}

function yearOf(date: string | null | undefined): number | null {
  const y = date ? parseInt(date.slice(0, 4), 10) : NaN
  return Number.isFinite(y) ? y : null
}

// -------- actions --------

const primaryBtn =
  'inline-flex h-10 items-center gap-2 rounded-lg bg-white px-5 text-sm font-semibold text-neutral-950 shadow-lg shadow-black/30 hover:bg-neutral-200'
const secondaryBtn =
  'inline-flex h-10 items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900/60 px-4 text-sm text-neutral-200 hover:border-neutral-500'

function MovieActions({ channel }: { channel: Channel }) {
  const progress = useHistory((s) => s.progress.get(channel.id))
  const play = usePlayback((s) => s.play)
  // Read before the type guard below narrows `progress` away.
  const finished = progress?.finished ?? false
  if (isResumable(progress)) {
    return (
      <>
        <button onClick={() => play(channel, progress.timePos)} className={primaryBtn}>
          <Play className="h-4 w-4 fill-current" />
          Resume from {fmtResume(progress.timePos)}
        </button>
        <button
          onClick={() => {
            useHistory.getState().remove(channel.id).catch(() => {})
            play(channel, 0)
          }}
          className={secondaryBtn}
        >
          <RotateCcw className="h-4 w-4" />
          From the beginning
        </button>
      </>
    )
  }
  return (
    <button onClick={() => play(channel, null)} className={primaryBtn}>
      <Play className="h-4 w-4 fill-current" />
      {finished ? 'Watch again' : 'Play'}
    </button>
  )
}

function FavoriteButton({ channel }: { channel: Channel }) {
  const [fav, setFav] = useState<boolean | null>(null)
  const push = useToast((s) => s.push)
  useEffect(() => {
    let cancelled = false
    ipc
      .listFavorites()
      .then((list) => !cancelled && setFav(list.some((c) => c.id === channel.id)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [channel.id])
  const toggle = async () => {
    try {
      setFav(await ipc.toggleFavorite(channel.id))
    } catch (e) {
      push('error', String(e))
    }
  }
  return (
    <button onClick={toggle} className={secondaryBtn} aria-pressed={!!fav}>
      <Star className={cn('h-4 w-4', fav && 'fill-accent-300 text-accent-300')} />
      {fav ? 'In favorites' : 'Favorite'}
    </button>
  )
}

// -------- seasons --------

function Seasons({ item }: { item: Extract<LibraryItem, { type: 'show' }> }) {
  const { episodes, loading, error } = useEpisodes(item)
  const progress = useHistory((s) => s.progress)
  const current = usePlayback((s) => s.channel)
  const requestPlay = usePlayback((s) => s.requestPlay)

  const seasons = useMemo(() => {
    const map = new Map<number, Episode[]>()
    for (const ep of episodes) map.set(ep.season, [...(map.get(ep.season) ?? []), ep])
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [episodes])

  // "Continue": the most recently watched episode if it's unfinished,
  // otherwise the one after it; the first episode for a fresh show.
  const next = useMemo(() => nextEpisode(episodes, progress), [episodes, progress])

  const [season, setSeason] = useState<number | null>(null)
  const shown = season ?? next?.season ?? seasons[0]?.[0] ?? null
  const list = seasons.find(([s]) => s === shown)?.[1] ?? []

  if (loading) {
    return (
      <div className="mt-10 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-neutral-900/80" />
        ))}
      </div>
    )
  }
  if (error && episodes.length === 0) {
    return <p className="mt-10 text-sm text-neutral-500">Couldn't load episodes: {error}</p>
  }

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-center gap-2">
        {next && (
          <button onClick={() => requestPlay(next.episode.channel)} className={cn(primaryBtn, 'mr-3')}>
            <Play className="h-4 w-4 fill-current" />
            {next.label}
          </button>
        )}
        {seasons.length > 1 &&
          seasons.map(([s]) => (
            <button
              key={s}
              onClick={() => setSeason(s)}
              className={cn(
                'h-8 rounded-full px-3.5 text-sm transition-colors',
                s === shown ? 'bg-white text-neutral-950' : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800',
              )}
            >
              {s > 0 ? `Season ${s}` : 'Other'}
            </button>
          ))}
      </div>

      <ul className="mt-5 divide-y divide-neutral-900 overflow-hidden rounded-xl border border-neutral-900 bg-neutral-950/60">
        {list.map((ep) => {
          const p = progress.get(ep.channel.id)
          const active = current?.id === ep.channel.id
          return (
            <li key={ep.channel.id}>
              <button
                onClick={() => requestPlay(ep.channel)}
                className={cn(
                  'relative flex w-full items-center gap-4 px-4 py-3 text-left transition-colors',
                  active ? 'bg-accent-500/10' : 'hover:bg-neutral-900/70',
                )}
              >
                <span className="w-10 shrink-0 text-center text-sm font-semibold tabular-nums text-neutral-500">
                  {ep.episode || '–'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-neutral-100">
                    {ep.subtitle ?? (ep.episode ? `Episode ${ep.episode}` : parseTitle(ep.channel.name).title)}
                  </span>
                  {isResumable(p) && (
                    <span className="text-xs text-neutral-500">
                      {fmtResume(p.timePos)} of {fmtResume(p.duration)}
                    </span>
                  )}
                </span>
                {p?.finished && (
                  <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                    Watched
                  </span>
                )}
                {active && <span className="h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-accent-400" />}
                <ProgressStripe progress={p} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function nextEpisode(
  episodes: Episode[],
  progress: Map<number, HistoryProgress>,
): { episode: Episode; season: number; label: string } | null {
  if (episodes.length === 0) return null
  const ordered = [...episodes].sort((a, b) => a.season - b.season || a.episode - b.episode)
  let lastIdx = -1
  let lastAt = -1
  ordered.forEach((ep, i) => {
    const p = progress.get(ep.channel.id)
    if (p && p.watchedAt > lastAt) {
      lastAt = p.watchedAt
      lastIdx = i
    }
  })
  const mark = (ep: Episode) => (ep.season > 0 ? `S${ep.season} E${ep.episode}` : `Episode ${ep.episode}`)
  if (lastIdx === -1) {
    const first = ordered[0]
    return { episode: first, season: first.season, label: `Play ${mark(first)}` }
  }
  const last = ordered[lastIdx]
  if (isResumable(progress.get(last.channel.id))) {
    return { episode: last, season: last.season, label: `Continue ${mark(last)}` }
  }
  const following = ordered[lastIdx + 1]
  if (following) return { episode: following, season: following.season, label: `Next: ${mark(following)}` }
  return { episode: last, season: last.season, label: `Watch ${mark(last)} again` }
}
