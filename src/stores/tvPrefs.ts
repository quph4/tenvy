import { create } from 'zustand'
import type { Channel, MpvTrack, TrackPrefs } from '../types'

/**
 * Viewing preferences that make Tenvy behave like a TV: the audio and
 * subtitle languages last picked by hand (applied to every channel and
 * film), and whether to reopen the last channel at startup.
 */
interface TvPrefsState {
  tracks: TrackPrefs
  startWithLastChannel: boolean
  /** The user picked an audio track; remember its language. */
  pickedAudio(track: MpvTrack | undefined): void
  /** The user picked a subtitle track, or turned subtitles off (undefined). */
  pickedSubtitle(track: MpvTrack | undefined): void
  resetTracks(): void
  setStartWithLastChannel(on: boolean): void
}

const TRACKS_KEY = 'tenvy.trackPrefs'
const START_KEY = 'tenvy.startWithLastChannel'
const LAST_KEY = 'tenvy.lastChannelId'

const NO_PREFS: TrackPrefs = { audioLang: null, subLang: null, subsOff: false }

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* a preference isn't worth failing over */
  }
}

export const useTvPrefs = create<TvPrefsState>((set, get) => ({
  tracks: read(TRACKS_KEY, NO_PREFS),
  startWithLastChannel: read<{ on: boolean }>(START_KEY, { on: false }).on,

  pickedAudio(track) {
    if (!track?.lang) return
    const tracks = { ...get().tracks, audioLang: track.lang }
    set({ tracks })
    write(TRACKS_KEY, tracks)
  },
  pickedSubtitle(track) {
    const tracks = track
      ? { ...get().tracks, subsOff: false, subLang: track.lang ?? get().tracks.subLang }
      : { ...get().tracks, subsOff: true }
    set({ tracks })
    write(TRACKS_KEY, tracks)
  },
  resetTracks() {
    set({ tracks: NO_PREFS })
    write(TRACKS_KEY, NO_PREFS)
  },
  setStartWithLastChannel(on) {
    set({ startWithLastChannel: on })
    write(START_KEY, { on })
  },
}))

/** Remember the live channel now playing, for "start with last channel". */
export function rememberLastChannel(ch: Channel) {
  if (ch.kind !== 'live') return
  try {
    localStorage.setItem(LAST_KEY, String(ch.id))
  } catch {
    /* ignore */
  }
}

export function lastChannelId(): number | null {
  try {
    const n = Number(localStorage.getItem(LAST_KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// Streams tag tracks with ISO 639-2 codes; Intl wants the short form.
const SHORT: Record<string, string> = {
  swe: 'sv', eng: 'en', nor: 'no', nob: 'nb', dan: 'da', fin: 'fi', ger: 'de', deu: 'de',
  fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', ara: 'ar', tur: 'tr', pol: 'pl', rus: 'ru',
  por: 'pt', dut: 'nl', nld: 'nl', gre: 'el', ell: 'el', per: 'fa', fas: 'fa', hin: 'hi',
}

/** "swe" / "sv" → "Swedish"; unknown codes as they are. */
export function languageName(code: string | null): string | null {
  if (!code) return null
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(SHORT[code.toLowerCase()] ?? code)
    if (name && name.toLowerCase() !== code.toLowerCase()) return name
  } catch {
    /* not a code Intl knows */
  }
  return code
}
