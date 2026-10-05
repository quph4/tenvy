import { create } from 'zustand'
import type { Channel } from '../types'
import { ipc } from '../lib/ipc'
import { osd } from '../lib/osd'
import { parseEpisode, toEpisode } from '../lib/series'
import { END_GUARD } from './history'
import { usePlayback } from './playback'
import { useTvPrefs } from './tvPrefs'

/** Seconds between the end of an episode and the next one starting. */
export const UP_NEXT_SECONDS = 10

/**
 * Next episode: while an episode plays, the one after it is looked up;
 * when it ends, a countdown starts it (Enter plays it now, Esc cancels).
 * Off with Settings → Playback → "Play the next episode automatically".
 */
interface UpNextState {
  /** The episode after the one playing, once looked up. */
  next: Channel | null
  /** "S1 E3 · Title" for `next`. */
  label: string
  /** Counting down: when `next` starts (ms epoch); null otherwise. */
  startsAt: number | null
  playNow(): void
  cancel(): void
}

let timer: number | undefined

export const useUpNext = create<UpNextState>((set, get) => ({
  next: null,
  label: '',
  startsAt: null,

  playNow() {
    const next = get().next
    get().cancel()
    if (next) usePlayback.getState().requestPlay(next)
  },

  cancel() {
    window.clearInterval(timer)
    timer = undefined
    if (get().startsAt != null) {
      set({ startsAt: null })
      osd('', 1)
    }
  },
}))

function startCountdown() {
  const { next, label } = useUpNext.getState()
  if (!next) return
  const startsAt = Date.now() + UP_NEXT_SECONDS * 1000
  useUpNext.setState({ startsAt })
  const tick = () => {
    const left = Math.ceil((startsAt - Date.now()) / 1000)
    if (left <= 0) {
      useUpNext.getState().playNow()
      return
    }
    // On the video too, for fullscreen and the mini player.
    osd(`Next episode in ${left} s\n${label}\nEnter: play now · Esc: cancel`, 1500)
  }
  tick()
  timer = window.setInterval(tick, 1000)
}

/** The episode after `ch` in season/episode order, or null. */
export async function findNextEpisode(ch: Channel): Promise<Channel | null> {
  let rows: Channel[]
  if (ch.parentId != null) {
    rows = await ipc.listEpisodes(ch.parentId)
  } else {
    // A plain playlist: the show's episodes are rows named alike.
    const info = parseEpisode(ch.name)
    if (!info) return null
    const key = info.show.toLowerCase()
    rows = (await ipc.searchChannels(info.show, { sourceId: ch.sourceId, kind: 'series' })).filter(
      (c) => parseEpisode(c.name)?.show.toLowerCase() === key,
    )
  }
  const eps = rows.map(toEpisode).sort((a, b) => a.season - b.season || a.episode - b.episode)
  const i = eps.findIndex((e) => e.channel.id === ch.id)
  return i >= 0 ? (eps[i + 1]?.channel ?? null) : null
}

function labelOf(ch: Channel): string {
  const ep = toEpisode(ch)
  const mark = ep.season > 0 ? `S${ep.season} E${ep.episode}` : ep.episode > 0 ? `Episode ${ep.episode}` : ''
  const title = ep.subtitle && ep.subtitle !== ch.name ? ep.subtitle : ''
  return [mark, title].filter(Boolean).join(' · ') || ch.name
}

const isEpisode = (ch: Channel | null): ch is Channel => !!ch && ch.kind === 'series' && !ch.container

// Look up the next episode when one starts; count down when it ends.
usePlayback.subscribe((s, prev) => {
  if (s.channel?.id !== prev.channel?.id) {
    useUpNext.getState().cancel()
    useUpNext.setState({ next: null, label: '' })
    const ch = s.channel
    if (!isEpisode(ch)) return
    findNextEpisode(ch)
      .then((next) => {
        if (next && usePlayback.getState().channel?.id === ch.id) useUpNext.setState({ next, label: labelOf(next) })
      })
      .catch(() => {})
    return
  }
  // Seeking back from the end (or anything that resumes playback) calls it off.
  if (!s.eofReached && prev.eofReached) useUpNext.getState().cancel()
  if (s.eofReached && !prev.eofReached && isEpisode(s.channel) && useUpNext.getState().startsAt == null) {
    // The real end, not a dropped stream (the connection keeper reopens those).
    const atEnd = s.duration != null && s.timePos != null && s.timePos >= s.duration - END_GUARD * 2
    if (atEnd && useTvPrefs.getState().autoNext) startCountdown()
  }
})
