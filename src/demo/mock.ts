/**
 * Demo mode for screenshots and the website: `pnpm dev`, then open
 * http://localhost:1420/?demo in a browser. The Tauri backend is replaced
 * by made-up channels, films, series and a programme guide, with artwork
 * drawn here — nothing real, so screenshots are safe to publish.
 *
 * Only ever loaded in development (see main.tsx); never in the app.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import type { Channel, ChannelKind, Programme } from '../types'

// ---------- artwork ----------

const svg = (s: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

function logo(name: string, hue: number): string {
  const words = name.split(' ')
  const big = words[0]
  const small = words.slice(1).join(' ')
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
    <rect width="160" height="160" rx="28" fill="hsl(${hue} 30% 14%)"/>
    <rect x="1" y="1" width="158" height="158" rx="27" fill="none" stroke="hsl(${hue} 60% 60% / .25)"/>
    <text x="80" y="${small ? 82 : 92}" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="800"
      font-size="${big.length > 6 ? 30 : 38}" fill="hsl(${hue} 70% 72%)">${esc(big)}</text>
    ${small ? `<text x="80" y="114" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="600" font-size="22" fill="#e5e5e5">${esc(small)}</text>` : ''}
  </svg>`)
}

/** A simple film poster: sky gradient, sun, layered hills, title. */
function poster(title: string, hue: number, seed: number, w = 300, h = 450): string {
  const r = rng(seed)
  const hills = [0.62, 0.72, 0.82].map((base, i) => {
    let d = `M0 ${h}`
    for (let x = 0; x <= w; x += w / 6) d += ` L${x.toFixed(0)} ${(h * base + (r() - 0.5) * h * 0.12).toFixed(0)}`
    return `<path d="${d} L${w} ${h} Z" fill="hsl(${hue + i * 8} ${35 - i * 5}% ${16 - i * 4}%)" />`
  })
  const portrait = h > w
  const sunX = w * (0.2 + r() * 0.6)
  const sunY = h * (0.28 + r() * 0.26)
  const sunR = w * (portrait ? 0.1 + r() * 0.1 : 0.05 + r() * 0.04)
  const lines = portrait ? wrap(title.toUpperCase(), 12) : [title.toUpperCase()]
  const fs = portrait ? 30 : 64
  const ty = portrait ? h - 40 - (lines.length - 1) * (fs + 4) : h - 70
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 55% 22%)"/><stop offset=".6" stop-color="hsl(${hue + 25} 60% 48%)"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="hsl(${hue + 40} 90% 78% / .9)"/>
    ${hills.join('')}
    <rect y="${h * 0.6}" width="${w}" height="${h * 0.4}" fill="url(#g)" opacity=".08"/>
    ${lines
      .map(
        (l, i) =>
          `<text x="${portrait ? w / 2 : 60}" y="${ty + i * (fs + 4)}" text-anchor="${portrait ? 'middle' : 'start'}"
            font-family="Georgia, serif" font-size="${fs}" letter-spacing="${portrait ? 3 : 6}" fill="#f5f0e6">${esc(l)}</text>`,
      )
      .join('')}
  </svg>`)
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const word of text.split(' ')) {
    const last = out[out.length - 1]
    if (last && (last + ' ' + word).length <= width) out[out.length - 1] = last + ' ' + word
    else out.push(word)
  }
  return out
}

function rng(seed: number) {
  let s = seed * 9301 + 49297
  return () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
}

// ---------- catalogue ----------

const LIVE: [string, string, number, number | null][] = [
  // name, group, hue, catch-up days
  ['Nordic One HD', 'Entertainment', 205, 7],
  ['Nordic Two HD', 'Entertainment', 190, 7],
  ['Studio 5', 'Entertainment', 330, null],
  ['Travel+ HD', 'Documentary', 160, 3],
  ['Wild Planet', 'Documentary', 120, null],
  ['History Now', 'Documentary', 30, 3],
  ['Arena Sport 1', 'Sports', 0, 7],
  ['Arena Sport 2', 'Sports', 10, 7],
  ['Arena Sport 3', 'Sports', 20, null],
  ['Motor TV', 'Sports', 45, null],
  ['Global News 24', 'News', 215, 2],
  ['Business Day', 'News', 260, null],
  ['Cinema Club', 'Movies', 280, null],
  ['Classic Reels', 'Movies', 40, null],
  ['Kids Planet', 'Kids', 95, null],
  ['Toon Town', 'Kids', 300, null],
  ['Music Box', 'Music', 315, null],
  ['Chill FM TV', 'Music', 175, null],
]

const MOVIES: [string, string, number, number][] = [
  // title, group, year, rating
  ['Glass Harbour', 'New releases', 2026, 7.8],
  ['The Northern Line', 'New releases', 2026, 7.1],
  ['Midnight Orchard', 'New releases', 2025, 8.2],
  ['Paper Satellites', 'New releases', 2026, 6.9],
  ['Copper Coast', 'New releases', 2025, 7.4],
  ['Second Signal', 'Thriller', 2024, 7.6],
  ['Quiet Engines', 'Thriller', 2025, 6.8],
  ['Saltwater Kings', 'Action', 2024, 7.0],
  ['The Long Thaw', 'Drama', 2023, 8.0],
  ['Velvet Hour', 'Drama', 2025, 7.3],
  ['Lantern Bay', 'Family', 2024, 7.2],
  ['Atlas of Small Things', 'Family', 2026, 7.9],
  ['Blue Meridian', 'Action', 2025, 6.7],
  ['Hollow Pines', 'Thriller', 2023, 7.5],
  ['The Cartographer', 'Drama', 2024, 8.4],
  ['Echo Valley', 'Action', 2026, 6.6],
  ['Summer of Kites', 'Family', 2025, 7.0],
  ['Northern Lights Hotel', 'Comedy', 2024, 6.9],
  ['Small Hours', 'Comedy', 2026, 7.2],
  ['The Last Ferry', 'Drama', 2025, 7.7],
]

const SERIES: [string, string, number, number][] = [
  ['Coldwater', 'Crime', 2025, 8.3],
  ['The Inventors', 'Documentary', 2026, 8.0],
  ['Harbour Lights', 'Drama', 2024, 7.6],
  ['Kitchen Masters', 'Reality', 2026, 6.9],
  ['Signal & Noise', 'Crime', 2025, 7.9],
  ['Wild North', 'Documentary', 2024, 8.6],
  ['Neon District', 'Crime', 2026, 7.4],
  ['The Weekenders', 'Comedy', 2025, 7.1],
]

const base = (id: number, kind: ChannelKind): Channel => ({
  id,
  sourceId: 1,
  tvgId: null,
  name: '',
  logo: null,
  group: null,
  streamUrl: `http://demo.invalid/${id}`,
  sortOrder: id,
  kind,
  container: false,
  parentId: null,
  season: null,
  episode: null,
  archiveDays: null,
  rating: null,
  year: null,
  added: null,
})

const now = Math.floor(Date.now() / 1000)

const channels: Channel[] = [
  ...LIVE.map(([name, group, hue, archive], i) => ({
    ...base(1 + i, 'live'),
    name,
    group,
    tvgId: `demo.${1 + i}`,
    logo: logo(name.replace(/ HD$/, ''), hue),
    archiveDays: archive,
  })),
  ...MOVIES.map(([name, group, year, rating], i) => ({
    ...base(100 + i, 'movie'),
    name,
    group,
    year,
    rating,
    added: now - i * 86_400 * 3,
    logo: poster(name, (i * 37) % 360, i + 1),
  })),
  ...SERIES.map(([name, group, year, rating], i) => ({
    ...base(300 + i, 'series'),
    name,
    group,
    year,
    rating,
    container: true,
    added: now - i * 86_400 * 5,
    logo: poster(name, (i * 53 + 180) % 360, i + 50),
  })),
]
const byId = new Map(channels.map((c) => [c.id, c]))

function episodes(show: Channel): Channel[] {
  const out: Channel[] = []
  for (let s = 1; s <= 2; s++)
    for (let e = 1; e <= 8; e++)
      out.push({
        ...base(1000 + show.id * 20 + s * 10 + e, 'series'),
        name: `${show.name} S0${s}E0${e}`,
        parentId: show.id,
        season: s,
        episode: e,
        logo: show.logo,
      })
  return out
}

// ---------- guide ----------

const SHOWS: Record<string, string[]> = {
  Entertainment: ['Kitchen Masters', 'Coldwater', 'The Quiz Hour', 'Harbour Lights', 'Saturday Live', 'Home Rescue', 'The Weekenders'],
  Documentary: ['Wild North', 'The Inventors', 'Rivers of Europe', 'Great Railway Journeys', 'Deep Ocean', 'Lost Cities'],
  Sports: ['Football: Northfield v Riverside', 'Hockey Night', 'Tennis Highlights', 'Sport Centre', 'Golf: The Coastal Open', 'Cycling Live'],
  News: ['Morning Report', 'World Today', 'Business Hour', 'Evening News', 'Weather', 'Late Edition'],
  Movies: ['Glass Harbour', 'The Long Thaw', 'Copper Coast', 'Second Signal', 'Velvet Hour'],
  Kids: ['Puzzle Pals', 'Rocket Club', 'The Treehouse', 'Little Explorers', 'Dino Days'],
  Music: ['Top 40 Countdown', 'Chill Sessions', 'Live at the Hall', 'Throwback Hits'],
}
const LENGTHS = [30, 45, 60, 60, 90, 120]

const guideCache = new Map<string, Programme[]>()
function guide(tvgId: string): Programme[] {
  const hit = guideCache.get(tvgId)
  if (hit) return hit
  const ch = channels.find((c) => c.tvgId === tvgId)!
  const pool = SHOWS[ch.group ?? 'Entertainment'] ?? SHOWS.Entertainment
  const r = rng(ch.id * 7)
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  let t = Math.floor(day.getTime() / 1000) - 2 * 86_400 - Math.floor(r() * 4) * 900
  const end = t + 6 * 86_400
  const out: Programme[] = []
  while (t < end) {
    const len = LENGTHS[Math.floor(r() * LENGTHS.length)] * 60
    const title = pool[Math.floor(r() * pool.length)]
    out.push({
      channelTvgId: tvgId,
      start: t,
      stop: t + len,
      title,
      description: `${title} on ${ch.name}. A made-up programme for the Tenvy demo.`,
    })
    t += len
  }
  guideCache.set(tvgId, out)
  return out
}

// ---------- state the app writes ----------

let favorites = new Set([1, 7, 11, 102])
const hiddenChannels = new Set<number>()
const progress = [
  { channelId: 102, timePos: 2900, duration: 6400, watchedAt: now - 3600, finished: false },
  { channelId: 108, timePos: 1200, duration: 7100, watchedAt: now - 86_400, finished: false },
  { channelId: 1, timePos: 0, duration: 0, watchedAt: now - 7200, finished: false },
]
const reminders: { channelId: number; start: number; stop: number; title: string }[] = []
{
  const next = guide('demo.7').find((p) => p.start > now + 4 * 3600)!
  reminders.push({ channelId: 7, start: next.start, stop: next.stop, title: next.title })
}

// ---------- IPC ----------

let sourceName = 'My provider'

type Args = Record<string, any>

function listChannels({ group, kind }: Args): Channel[] {
  if (group === '__favorites') return [...favorites].map((id) => byId.get(id)!).filter((c) => visible(c, false))
  return channels.filter((c) => (!kind || c.kind === kind) && (!group || c.group === group) && visible(c, !group) && !hiddenChannels.has(c.id))
}

// Category prefs as the app sets them: "kind/name" → flags.
const groupPrefs = new Map<string, { hidden: boolean; locked: boolean }>()
const parental = { pin: null as string | null, unlocked: false }
const isUnlocked = () => parental.pin == null || parental.unlocked
const prefOf = (c: Channel) => groupPrefs.get(`${c.kind}/${c.group}`) ?? { hidden: false, locked: false }
const visible = (c: Channel, skipHidden: boolean) => {
  const p = prefOf(c)
  return !(skipHidden && p.hidden) && !(p.locked && !isUnlocked())
}

function groups({ kind }: Args) {
  const counts = new Map<string, number>()
  for (const c of channels) if (!kind || c.kind === kind) counts.set(c.group!, (counts.get(c.group!) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count, ...(groupPrefs.get(`${kind}/${name}`) ?? { hidden: false, locked: false }), lockedByWord: false }))
}

function handle(cmd: string, a: Args = {}): unknown {
  switch (cmd) {
    case 'list_sources':
      if (new URLSearchParams(location.search).get('scene') === 'welcome') return []
      return [{ id: 1, kind: 'xtream', name: sourceName, url: 'http://line.example.com', updatedAt: now - 600 }]
    case 'rename_source':
      sourceName = a.name
      return null
    case 'list_groups':
      return groups(a)
    case 'list_channels':
      return listChannels(a)
    case 'search_channels': {
      const q = String(a.query).toLowerCase()
      return channels.filter((c) => c.name.toLowerCase().includes(q) && (!a.kind || c.kind === a.kind) && visible(c, true))
    }
    case 'list_episodes':
      return episodes(byId.get(a.channelId)!)
    case 'vod_details': {
      const c = byId.get(a.channelId)!
      const hue = ((c.id - (c.kind === 'movie' ? 100 : 300)) * 37) % 360
      return {
        plot: `${c.name} is a made-up ${c.kind === 'movie' ? 'film' : 'series'} for the Tenvy demo: a quiet, handsome story about people, places and the long way home.`,
        genre: c.group,
        cast: 'Ava Lindqvist, Noah Berg, Maja Holm, Elias Strand',
        director: 'Signe Dahl',
        releaseDate: `${c.year}-03-14`,
        rating: c.rating,
        duration: c.kind === 'movie' ? '01:52:00' : null,
        poster: c.logo,
        backdrop: poster(c.name, hue, c.id, 1280, 720),
        trailer: null,
      }
    }
    case 'source_stats':
      return { live: LIVE.length, movies: MOVIES.length, series: SERIES.length }
    case 'programmes_for_channels':
      return (a.tvgIds as string[]).flatMap((id) => guide(id).filter((p) => p.stop > a.from && p.start < a.to))
    case 'now_playing': {
      const t = Date.now() / 1000
      return (a.tvgIds as string[]).flatMap((id) => guide(id).filter((p) => p.start <= t && p.stop > t))
    }
    case 'list_favorites':
      return [...favorites].map((id) => byId.get(id)!)
    case 'reorder_favorites': {
      const ids = a.ids as number[]
      favorites = new Set([...ids.filter((id) => favorites.has(id)), ...[...favorites].filter((id) => !ids.includes(id))])
      return null
    }
    case 'set_channel_hidden':
      if (a.hidden) hiddenChannels.add(a.channelId)
      else hiddenChannels.delete(a.channelId)
      return null
    case 'list_hidden_channels':
      return [...hiddenChannels].map((id) => byId.get(id)!)
    case 'toggle_favorite':
      if (favorites.has(a.channelId)) favorites.delete(a.channelId)
      else favorites.add(a.channelId)
      return favorites.has(a.channelId)
    case 'list_history_progress':
      return progress
    case 'list_history':
      return progress.map((p) => ({ ...p, channel: byId.get(p.channelId)! }))
    case 'get_history_entry':
      return progress.find((p) => p.channelId === a.channelId) ?? null
    case 'list_reminders':
      return reminders.map((r) => ({ ...r, channel: byId.get(r.channelId)! }))
    case 'add_reminder':
      reminders.push({ channelId: a.channelId, start: a.start, stop: a.stop, title: a.title })
      return null
    case 'remove_reminder': {
      const i = reminders.findIndex((r) => r.channelId === a.channelId && r.start === a.start)
      if (i >= 0) reminders.splice(i, 1)
      return null
    }
    case 'recently_added':
      return channels
        .filter((c) => c.kind === a.kind && c.parentId == null && visible(c, true))
        .sort((x, y) => (y.added ?? 0) - (x.added ?? 0))
        .slice(0, a.limit)
    case 'account_info':
      return {
        status: 'Active',
        expiresAt: now + 214 * 86_400,
        isTrial: false,
        activeConnections: 0,
        maxConnections: 1,
        createdAt: now - 150 * 86_400,
      }
    case 'parental_status':
      return { pinSet: parental.pin != null, unlocked: isUnlocked() }
    case 'parental_unlock':
      if (a.pin !== parental.pin) return false
      parental.unlocked = true
      return true
    case 'parental_lock':
      parental.unlocked = false
      return null
    case 'set_parental_pin':
      parental.pin = a.new
      parental.unlocked = false
      return null
    case 'set_group_prefs':
      for (const name of a.names as string[]) {
        const key = `${a.kind}/${name}`
        const cur = groupPrefs.get(key) ?? { hidden: false, locked: false }
        groupPrefs.set(key, { hidden: a.hidden ?? cur.hidden, locked: a.locked ?? cur.locked })
      }
      return null
    case 'parental_words':
      return []
    case 'set_parental_words':
      return a.words
    case 'epg_offset':
      return 0
    case 'set_epg_offset':
      return null
    case 'export_backup':
    case 'restore_backup':
      return null
    case 'get_channel':
      return byId.get(a.id) ?? null
    case 'app_info':
      return {
        installedAt: now - 30 * 86_400,
        config: {
          model: 'free',
          support: { url: 'https://example.com', label: 'Support Tenvy', message: null },
          supportPrompt: null,
          community: null,
          announcements: [],
        },
      }
    case 'mpv_get_state':
      return {
        playing: false,
        paused: false,
        idle: true,
        timePos: null,
        duration: null,
        volume: 100,
        muted: false,
        audioTracks: [],
        subtitleTracks: [],
        currentAudio: null,
        currentSubtitle: null,
        errorSeq: 0,
        lastError: null,
        eofReached: false,
        buffering: false,
      }
    case 'plugin:updater|check':
      // scene=update: pretend a newer version is out.
      if (new URLSearchParams(location.search).get('scene') !== 'update') return null
      return {
        rid: 1,
        currentVersion: '0.1.1',
        version: '0.1.2',
        date: null,
        body: [
          '### Added',
          '- Recording of the channel you are watching',
          '- A TV mode for PCs connected to a TV',
          '',
          '### Fixed',
          '- The guide remembers the day you were looking at',
        ].join('\n'),
        rawJson: {},
      }
    case 'plugin:notification|is_permission_granted':
      return true
    default:
      // mpv_*, window and updater calls: nothing to do, nothing to report.
      return null
  }
}

export function installDemo() {
  mockWindows('main')
  mockIPC((cmd, payload) => handle(cmd, payload as Args), { shouldMockEvents: true })
  document.title = 'Tenvy (demo)'
  // Headless screenshots don't always advance CSS transitions; screen
  // recordings (no scene) keep them.
  if (new URLSearchParams(location.search).has('scene')) {
    const style = document.createElement('style')
    style.textContent = '*, *::before, *::after { transition: none !important; }'
    document.head.appendChild(style)
  }
}

/**
 * Jump straight to a screen, for scripted screenshots:
 * `?demo&scene=welcome|home|guide|movies|series|details|show|live|categories|update`.
 */
export async function applyScene() {
  const scene = new URLSearchParams(location.search).get('scene')
  if (!scene) return
  const [{ usePlaylist }, { useUI }] = await Promise.all([import('../stores/playlist'), import('../stores/ui')])
  // Let the app's own startup load the sources first.
  for (let i = 0; i < 50 && usePlaylist.getState().sources.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
  const pl = usePlaylist.getState()
  // Tenvy opens on Home; every other scene starts from the main view.
  if (scene !== 'home') useUI.getState().setView('player')
  if (scene === 'guide') useUI.getState().setView('epg')
  if (scene === 'movies' || scene === 'details') await pl.setActiveKind('movie')
  if (scene === 'series') await pl.setActiveKind('series')
  if (scene === 'details') await pl.openDetails(byId.get(102)!)
  if (scene === 'categories') useUI.getState().setManageCategories(true)
  if (scene === 'update') (await import('../stores/updater')).useUpdater.getState().checkForUpdates(false)
  if (scene === 'show') {
    await pl.setActiveKind('series')
    await pl.openDetails(byId.get(300)!)
  }
}
