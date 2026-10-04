import { useVirtualizer } from '@tanstack/react-virtual'
import { Film, MonitorPlay } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FAVORITES_GROUP, HISTORY_GROUP, usePlaylist } from '../../stores/playlist'
import { usePlayback } from '../../stores/playback'
import { useHistory } from '../../stores/history'
import { groupByShow, showFromContainer, type LibraryItem, type Show } from '../../lib/series'
import { parseTitle } from '../../lib/titles'
import { usePref } from '../../lib/prefs'
import type { Channel } from '../../types'
import { ListSkeleton, ProgressStripe } from '../ChannelList'
import { Details } from './Details'
import { Poster } from './Poster'

type LibrarySort = 'default' | 'added' | 'name' | 'rating' | 'year'

const SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'default', label: 'Provider order' },
  { value: 'added', label: 'Recently added' },
  { value: 'name', label: 'Name' },
  { value: 'rating', label: 'Rating' },
  { value: 'year', label: 'Year' },
]

/** One tile in the grid. */
interface Card {
  key: string
  title: string
  poster: string | null
  year: number | null
  rating: number | null
  added: number | null
  sortOrder: number
  /** For progress stripes (movies/episodes). */
  channel: Channel | null
  open(): void
}

/**
 * Movies and series: a poster grid for the active group, and a details
 * page for the selected title. Playing something switches App to the
 * full-width player.
 */
export function Library() {
  const { channels, loadingChannels, activeGroup, activeKind, selected, select } = usePlaylist()
  const [sort, setSort] = usePref<LibrarySort>('tenvy.library.sort', 'default')

  const cards = useMemo(
    () => sortCards(buildCards(channels, activeKind, activeGroup, select), sort),
    [channels, activeKind, activeGroup, select, sort],
  )

  if (selected) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <Details item={selected} onBack={() => select(null)} />
      </div>
    )
  }

  const label =
    activeGroup === FAVORITES_GROUP
      ? 'Favorites'
      : activeGroup === HISTORY_GROUP
        ? 'History'
        : activeGroup ?? (activeKind === 'movie' ? 'All movies' : 'All series')

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-neutral-950">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-800/70 px-6">
        <span className="text-neutral-500">
          {activeKind === 'movie' ? <Film className="h-4 w-4" /> : <MonitorPlay className="h-4 w-4" />}
        </span>
        <h1 className="truncate text-sm font-semibold text-neutral-100">{label}</h1>
        <span className="text-xs tabular-nums text-neutral-600">{cards.length.toLocaleString()}</span>
        <label className="ml-auto flex items-center gap-2 text-[11px] text-neutral-500">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as LibrarySort)}
            className="h-7 rounded-md border border-neutral-800 bg-neutral-900 px-2 text-xs text-neutral-200 outline-none hover:border-neutral-700"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loadingChannels && cards.length === 0 ? (
        <ListSkeleton />
      ) : cards.length === 0 ? (
        <div className="grid flex-1 place-items-center text-sm text-neutral-500">Nothing here yet.</div>
      ) : (
        <PosterGrid cards={cards} />
      )}
    </div>
  )
}

function buildCards(
  channels: Channel[],
  kind: string,
  group: string | null,
  select: (item: LibraryItem | null) => void,
): Card[] {
  const flat = group === FAVORITES_GROUP || group === HISTORY_GROUP || kind === 'movie'
  if (flat) {
    return channels.map((ch) => {
      const { title, year } = parseTitle(ch.name)
      return {
        key: `ch:${ch.id}`,
        title,
        poster: ch.logo,
        year: ch.year ?? year,
        rating: ch.rating,
        added: ch.added,
        sortOrder: ch.sortOrder,
        channel: ch.container ? null : ch,
        open: () => openChannel(ch, select),
      }
    })
  }
  return groupByShow(channels).map((show) => showCard(show, select))
}

function showCard(show: Show, select: (item: LibraryItem | null) => void): Card {
  const c = show.container
  const parsed = parseTitle(show.name)
  return {
    key: show.key,
    title: parsed.title,
    poster: show.logo,
    year: c?.year ?? parsed.year,
    rating: c?.rating ?? null,
    added: c?.added ?? null,
    sortOrder: c?.sortOrder ?? Math.min(...show.episodes.map((e) => e.channel.sortOrder)),
    channel: null,
    open: () => select({ type: 'show', show }),
  }
}

/** Movies and shows open their details; a lone episode just plays. */
function openChannel(ch: Channel, select: (item: LibraryItem | null) => void) {
  if (ch.container) select({ type: 'show', show: showFromContainer(ch) })
  else if (ch.kind === 'movie') select({ type: 'movie', channel: ch })
  else usePlayback.getState().requestPlay(ch)
}

function sortCards(cards: Card[], sort: LibrarySort): Card[] {
  const by = (f: (c: Card) => number | string | null, dir: 1 | -1) =>
    [...cards].sort((a, b) => {
      const x = f(a)
      const y = f(b)
      // Missing values sort last regardless of direction.
      if (x === null && y === null) return a.sortOrder - b.sortOrder
      if (x === null) return 1
      if (y === null) return -1
      if (typeof x === 'string' && typeof y === 'string') return x.localeCompare(y) * dir
      return ((x as number) - (y as number)) * dir || a.sortOrder - b.sortOrder
    })
  switch (sort) {
    case 'added':
      return by((c) => c.added, -1)
    case 'name':
      return by((c) => c.title, 1)
    case 'rating':
      return by((c) => c.rating, -1)
    case 'year':
      return by((c) => c.year, -1)
    default:
      return by((c) => c.sortOrder, 1)
  }
}

// -------- grid --------

const CARD_MIN_WIDTH = 150
const GAP = 18
const PAD = 24
/** Title + meta line under each poster. */
const CAPTION_HEIGHT = 46

function PosterGrid({ cards }: { cards: Card[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const inner = Math.max(0, width - PAD * 2)
  const cols = Math.max(2, Math.floor((inner + GAP) / (CARD_MIN_WIDTH + GAP)))
  const cardWidth = (inner - GAP * (cols - 1)) / cols
  const rowHeight = Math.round(cardWidth * 1.5 + CAPTION_HEIGHT + GAP)
  const rows = Math.ceil(cards.length / cols)

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  })
  // Row height follows the window width; re-measure when it changes.
  useEffect(() => virt.measure(), [rowHeight, virt])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div style={{ height: virt.getTotalSize() + PAD, position: 'relative' }}>
        {width > 0 &&
          virt.getVirtualItems().map((row) => (
            <div
              key={row.key}
              className="absolute left-0 right-0 grid"
              style={{
                top: row.start + PAD,
                paddingLeft: PAD,
                paddingRight: PAD,
                gap: GAP,
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              }}
            >
              {cards.slice(row.index * cols, row.index * cols + cols).map((c) => (
                <PosterCard key={c.key} card={c} />
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}

function PosterCard({ card }: { card: Card }) {
  const progress = useHistory((s) => (card.channel ? s.progress.get(card.channel.id) : undefined))
  const meta = [card.year, card.rating ? `★ ${card.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')
  return (
    <button onClick={card.open} className="group min-w-0 text-left outline-none">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/5 transition group-hover:ring-2 group-hover:ring-accent-400/70 group-focus-visible:ring-2 group-focus-visible:ring-accent-400">
        <Poster src={card.poster} title={card.title} className="transition duration-300 group-hover:scale-[1.03]" />
        {progress?.finished && (
          <span className="absolute right-1.5 top-1.5 rounded bg-emerald-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow">
            Watched
          </span>
        )}
        <ProgressStripe progress={progress} />
      </div>
      <div className="mt-2 truncate text-[13px] font-medium text-neutral-200 group-hover:text-white">{card.title}</div>
      <div className="h-4 truncate text-[11px] tabular-nums text-neutral-500">{meta}</div>
    </button>
  )
}

