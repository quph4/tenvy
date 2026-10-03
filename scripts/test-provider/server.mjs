// A local, fake Xtream Codes provider for testing Tenvy end to end without
// a real IPTV subscription: login, live channels (paced like real live TV),
// a programme guide with catch-up, movies, series, account details — plus
// failures on demand (dropped or stalled streams, expired account,
// connection limits, outages).
//
//   node scripts/test-provider/server.mjs            → http://127.0.0.1:8788
//   username: test   password: test
//
// Video is generated locally by the bundled mpv on first run (a test card
// with a seconds counter and a tone) — nothing is downloaded.
//
// Control while running (open in a browser or curl):
//   /__status                     current state
//   /__control?drop=1             cut every open stream now
//   /__control?stall=1 | stall=0  streams stop sending data (but stay open)
//   /__control?fail=3             the next 3 stream requests fail with 503
//   /__control?down=1 | down=0    the whole server answers 503
//   /__control?expired=1          account expired (auth still ok)
//   /__control?max=2              allowed simultaneous streams (default 1)
//   /__control?reset=1            back to normal

import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MEDIA = join(HERE, 'media')
const MPV = join(HERE, '..', '..', 'src-tauri', 'resources', 'mpv', 'mpv.exe')
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const PORT = Number(arg('port', 8788))
const USER = arg('user', 'test')
const PASS = arg('pass', 'test')
const HOST = `http://127.0.0.1:${PORT}`
const LIVE_SECONDS = 300
const MOVIE_SECONDS = 600

// ---------- media ----------

function ensureMedia() {
  mkdirSync(MEDIA, { recursive: true })
  const make = (file, seconds, freq, fmt) => {
    if (existsSync(join(MEDIA, file))) return
    console.log(`generating ${file} with mpv…`)
    const r = spawnSync(MPV, [
      '--no-config', '--really-quiet',
      `av://lavfi:testsrc=size=1280x720:rate=25:duration=${seconds}`,
      `--audio-file=av://lavfi:sine=frequency=${freq}:beep_factor=2:duration=${seconds}`,
      `--o=${join(MEDIA, file)}`, `--of=${fmt}`,
      '--ovc=libx264', '--ovcopts=preset=veryfast,crf=30,g=50', '--oac=aac',
    ], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`mpv failed to generate ${file}`)
  }
  make('live.ts', LIVE_SECONDS, 440, 'mpegts')
  make('movie.mp4', MOVIE_SECONDS, 330, 'mp4')
}

// ---------- catalogue ----------

const now = () => Math.floor(Date.now() / 1000)
const T0 = now()

const LIVE_CATS = [
  { id: '1', name: 'Test Nordic' },
  { id: '2', name: 'Test Sports' },
  { id: '3', name: 'Test News' },
  { id: '4', name: 'For Adults' },
]
const LIVE = [
  { id: 100, name: '-= Test channels =-', cat: '1' },
  { id: 101, name: 'Test One HD', cat: '1', archive: 3 },
  { id: 102, name: 'Test Two HD', cat: '1', archive: 3 },
  { id: 103, name: 'Test Kids', cat: '1' },
  { id: 104, name: 'Test Sport 1', cat: '2', archive: 2 },
  { id: 105, name: 'Test Sport 2', cat: '2' },
  { id: 106, name: 'Test News 24', cat: '3', archive: 1 },
  { id: 107, name: 'Test Weather', cat: '3' },
  { id: 108, name: 'Test Late Night', cat: '4' },
]
const VOD_CATS = [
  { id: '11', name: 'Test Films' },
  { id: '12', name: 'Test Classics' },
]
const MOVIES = [
  { id: 201, name: 'The Test Pattern (2026)', cat: '11', rating: '7.4', year: 2026 },
  { id: 202, name: 'Signal Lost (2025)', cat: '11', rating: '6.8', year: 2025 },
  { id: 203, name: 'Color Bars Forever (2024)', cat: '11', rating: '8.1', year: 2024 },
  { id: 204, name: 'One Kilohertz (1999)', cat: '12', rating: '7.0', year: 1999 },
  { id: 205, name: 'Buffering (2023)', cat: '12', rating: '5.9', year: 2023 },
  // Several audio languages and subtitles: a public test stream (Tears of
  // Steel, CC BY) from Unified Streaming, played straight from them.
  { id: 206, name: 'Tears of Steel (2012)', cat: '12', rating: '6.5', year: 2012, remote: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8' },
]
const SERIES_CATS = [{ id: '21', name: 'Test Series' }]
const SERIES = [
  { id: 301, name: 'Reconnect', cat: '21', rating: '8.0' },
  { id: 302, name: 'The Guide', cat: '21', rating: '7.2' },
]
const EPISODES = (sid) =>
  [1, 2].flatMap((season) =>
    [1, 2, 3].map((ep) => ({ id: sid * 100 + season * 10 + ep, season, ep })),
  )

const HUES = [210, 330, 120, 30, 280, 0, 180, 60, 300, 90]
const svgTile = (text, hue, w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,35%)"/>` +
  `<stop offset="1" stop-color="hsl(${hue + 30},50%,12%)"/></linearGradient></defs>` +
  `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
  `<text x="50%" y="${h > w ? '82%' : '58%'}" text-anchor="middle" font-family="Segoe UI,Arial" font-weight="700" ` +
  `font-size="${Math.round(w / 9)}" fill="#fff">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`

// ---------- guide ----------

const SHOWS = ['Morning Test', 'Signal Check', 'The Pattern Hour', 'Tone at 440', 'Late Bars', 'Test Cup Final', 'Weather Now']
function programmes(ch) {
  const out = []
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  let t = Math.floor(day.getTime() / 1000) - 2 * 86400
  let i = ch.id
  while (t < Math.floor(day.getTime() / 1000) + 3 * 86400) {
    const len = [30, 60, 45, 90][i % 4] * 60
    out.push({ start: t, stop: t + len, title: `${SHOWS[i % SHOWS.length]}`, desc: `A test programme on ${ch.name}.` })
    t += len
    i += 3
  }
  return out
}
const xmltvTime = (t) => {
  const d = new Date(t * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`
}
function xmltv() {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="tenvy-test-provider">\n'
  for (const ch of LIVE.slice(1)) x += `  <channel id="test.${ch.id}"><display-name>${esc(ch.name)}</display-name></channel>\n`
  for (const ch of LIVE.slice(1))
    for (const p of programmes(ch))
      x += `  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="test.${ch.id}"><title>${esc(p.title)}</title><desc>${esc(p.desc)}</desc></programme>\n`
  return x + '</tv>\n'
}

// ---------- state ----------

const state = { expired: false, stall: false, fail: 0, down: false, max: 1 }
const streams = new Set() // open stream responses

const json = (res, v, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(v))
}

function userInfo(ok) {
  if (!ok) return { user_info: { auth: 0 } }
  return {
    user_info: {
      username: USER,
      auth: 1,
      status: state.expired ? 'Expired' : 'Active',
      exp_date: String(state.expired ? now() - 86400 : T0 + 30 * 86400),
      is_trial: '0',
      active_cons: String(streams.size),
      max_connections: String(state.max),
      created_at: String(T0 - 200 * 86400),
      allowed_output_formats: ['ts', 'm3u8'],
    },
    server_info: { url: '127.0.0.1', port: String(PORT), timezone: 'Europe/Stockholm', time_now: new Date().toISOString() },
  }
}

function api(q, res) {
  const ok = q.get('username') === USER && q.get('password') === PASS
  const action = q.get('action')
  if (!action || !ok) return json(res, userInfo(ok))
  const cats = (list) => list.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 }))
  switch (action) {
    case 'get_live_categories':
      return json(res, cats(LIVE_CATS))
    case 'get_live_streams':
      return json(res, LIVE.map((c, i) => ({
        num: i + 1, name: c.name, stream_type: 'live', stream_id: c.id,
        stream_icon: `${HOST}/img/logo/${c.id}.svg`, epg_channel_id: c.id === 100 ? null : `test.${c.id}`,
        added: String(T0 - 86400 * i), category_id: c.cat, container_extension: 'ts',
        tv_archive: c.archive ? 1 : 0, tv_archive_duration: c.archive ? String(c.archive) : '0',
      })))
    case 'get_vod_categories':
      return json(res, cats(VOD_CATS))
    case 'get_vod_streams':
      return json(res, MOVIES.map((m, i) => ({
        num: i + 1, name: m.name, stream_type: 'movie', stream_id: m.id,
        stream_icon: `${HOST}/img/poster/${m.id}.svg`, rating: m.rating, added: String(T0 - 86400 * (i + 1)),
        category_id: m.cat, container_extension: 'mp4',
      })))
    case 'get_vod_info': {
      const m = MOVIES.find((x) => String(x.id) === q.get('vod_id'))
      if (!m) return json(res, {})
      return json(res, {
        info: {
          plot: `${m.name} is a made-up film from Tenvy's test provider.`, cast: 'Ada Tester, Bo Bitrate',
          director: 'Cee Codec', genre: 'Test', releasedate: `${m.year}-01-01`, rating: m.rating,
          duration_secs: MOVIE_SECONDS, movie_image: `${HOST}/img/poster/${m.id}.svg`,
          backdrop_path: [`${HOST}/img/backdrop/${m.id}.svg`], youtube_trailer: '',
        },
        movie_data: { stream_id: m.id, name: m.name, container_extension: 'mp4' },
      })
    }
    case 'get_series_categories':
      return json(res, cats(SERIES_CATS))
    case 'get_series':
      return json(res, SERIES.map((s, i) => ({
        num: i + 1, name: s.name, series_id: s.id, cover: `${HOST}/img/poster/${s.id}.svg`,
        rating: s.rating, category_id: s.cat, last_modified: String(T0 - 3600 * i),
      })))
    case 'get_series_info': {
      const s = SERIES.find((x) => String(x.id) === q.get('series_id'))
      if (!s) return json(res, {})
      const episodes = {}
      for (const e of EPISODES(s.id)) {
        ;(episodes[e.season] ??= []).push({
          id: String(e.id), episode_num: e.ep, season: e.season, title: `${s.name} S0${e.season}E0${e.ep}`,
          container_extension: 'mp4', info: { duration_secs: MOVIE_SECONDS, plot: 'A test episode.' },
        })
      }
      return json(res, {
        info: { name: s.name, cover: `${HOST}/img/poster/${s.id}.svg`, plot: `${s.name}, a made-up series.`, rating: s.rating, genre: 'Test' },
        episodes,
      })
    }
    default:
      return json(res, [])
  }
}

// ---------- streams ----------

/** Live: the test card in a loop, paced at its real bitrate. */
function streamLive(req, res) {
  const file = join(MEDIA, 'live.ts')
  const size = statSync(file).size
  const perSecond = size / LIVE_SECONDS
  res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-cache' })
  let pos = 0
  let credit = perSecond * 3 // a little burst so playback starts quickly
  let last = Date.now()
  let busy = false
  const tick = setInterval(async () => {
    const t = Date.now()
    credit += ((t - last) / 1000) * perSecond
    last = t
    if (busy || state.stall || res.writableNeedDrain || res.destroyed) return
    busy = true
    try {
      while (credit > 0 && !res.destroyed) {
        const n = Math.min(Math.floor(credit), 188 * 512, size - pos)
        if (n <= 0) break
        res.write(await readChunk(file, pos, n))
        pos += n
        credit -= n
        if (pos >= size) pos = 0 // loop
      }
    } finally {
      busy = false
    }
  }, 100)
  res.on('close', () => clearInterval(tick))
}

let handle = null
async function readChunk(file, pos, n) {
  handle ??= await open(file, 'r')
  const buf = Buffer.alloc(n)
  await handle.read(buf, 0, n, pos)
  return buf
}

/** Films, episodes and catch-up: the 10-minute file, with Range support. */
function streamFile(req, res, file, type) {
  const size = statSync(file).size
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  let start = 0
  let end = size - 1
  if (m) {
    start = m[1] ? Number(m[1]) : size - Number(m[2])
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      return res.end()
    }
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
  } else {
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size })
  }
  const s = createReadStream(file, { start, end })
  // Stalling a file stream: pause it while state.stall is on.
  const watch = setInterval(() => (state.stall ? s.pause() : s.resume()), 200)
  s.pipe(res)
  res.on('close', () => {
    clearInterval(watch)
    s.destroy()
  })
}

function stream(req, res, kind, parts) {
  const [user, pass] = parts
  if (user !== USER || pass !== PASS) return json(res, { error: 'unauthorized' }, 401)
  if (state.expired) return json(res, { error: 'expired' }, 403)
  if (state.fail > 0) {
    state.fail--
    return json(res, { error: 'temporarily unavailable' }, 503)
  }
  if (streams.size >= state.max) {
    console.log(`  refused: ${streams.size}/${state.max} connections in use`)
    return json(res, { error: 'max connections reached' }, 403)
  }
  const remote = kind === 'movie' && MOVIES.find((m) => String(m.id) === parts[2])?.remote
  if (remote) {
    res.writeHead(302, { location: remote })
    return res.end()
  }
  streams.add(res)
  res.on('close', () => streams.delete(res))
  if (kind === 'live') return streamLive(req, res)
  return streamFile(req, res, join(MEDIA, 'movie.mp4'), kind === 'timeshift' ? 'video/mp2t' : 'video/mp4')
}

// ---------- server ----------

ensureMedia()

createServer((req, res) => {
  const url = new URL(req.url, HOST)
  const p = url.pathname
  if (!p.startsWith('/img/')) console.log(`${new Date().toLocaleTimeString()} ${req.method} ${p}${url.searchParams.get('action') ? ' ' + url.searchParams.get('action') : ''}`)

  if (p === '/__status') return json(res, { ...state, openStreams: streams.size })
  if (p === '/__control') {
    const q = url.searchParams
    if (q.has('reset')) Object.assign(state, { expired: false, stall: false, fail: 0, down: false, max: 1 })
    if (q.has('drop')) for (const s of streams) s.destroy()
    if (q.has('stall')) state.stall = q.get('stall') === '1'
    if (q.has('fail')) state.fail = Number(q.get('fail')) || 0
    if (q.has('down')) state.down = q.get('down') === '1'
    if (q.has('expired')) state.expired = q.get('expired') === '1'
    if (q.has('max')) state.max = Number(q.get('max')) || 1
    return json(res, { ...state, openStreams: streams.size })
  }
  if (state.down) return json(res, { error: 'down' }, 503)

  const img = /^\/img\/(logo|poster|backdrop)\/(\d+)\.svg$/.exec(p)
  if (img) {
    const id = Number(img[2])
    const item = [...LIVE, ...MOVIES, ...SERIES].find((x) => x.id === id)
    const name = (item?.name ?? 'Test').replace(/ \(\d{4}\)$/, '')
    const [w, h] = img[1] === 'logo' ? [160, 160] : img[1] === 'poster' ? [300, 450] : [1280, 720]
    res.writeHead(200, { 'content-type': 'image/svg+xml' })
    return res.end(svgTile(img[1] === 'logo' ? name.replace(/^Test /, '').slice(0, 10) : name, HUES[id % HUES.length], w, h))
  }
  if (p === '/player_api.php') return api(url.searchParams, res)
  if (p === '/xmltv.php') {
    const ok = url.searchParams.get('username') === USER && url.searchParams.get('password') === PASS
    if (!ok) return json(res, { error: 'unauthorized' }, 401)
    res.writeHead(200, { 'content-type': 'application/xml' })
    return res.end(xmltv())
  }
  if (p === '/config.json') {
    // What the app reads at startup (TENVY_CONFIG_URL), for testing the
    // support link, the support prompt and announcements.
    return json(res, {
      model: 'free',
      support: { url: 'https://example.org/support-tenvy', label: 'Support Tenvy', message: 'Test prompt from the test provider.' },
      supportPrompt: { afterDays: 0, everyDays: 1 },
      announcements: [{ id: `e2e-${T0}`, text: 'Hello from the test provider.', url: null }],
    })
  }
  if (p === '/playlist.m3u') {
    // A plain M3U playlist (not get.php), to test non-Xtream sources.
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl' })
    let m3u = `#EXTM3U url-tvg="${HOST}/xmltv.php?username=${USER}&password=${PASS}"
`
    for (const c of LIVE.slice(1, 5))
      m3u += `#EXTINF:-1 tvg-id="test.${c.id}" tvg-logo="${HOST}/img/logo/${c.id}.svg" group-title="M3U ${LIVE_CATS.find((x) => x.id === c.cat).name}",M3U ${c.name}
${HOST}/live/${USER}/${PASS}/${c.id}.ts
`
    return res.end(m3u)
  }
  if (p === '/get.php') {
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl' })
    let m3u = `#EXTM3U url-tvg="${HOST}/xmltv.php?username=${USER}&password=${PASS}"\n`
    for (const c of LIVE)
      m3u += `#EXTINF:-1 tvg-id="test.${c.id}" tvg-logo="${HOST}/img/logo/${c.id}.svg" group-title="${LIVE_CATS.find((x) => x.id === c.cat).name}",${c.name}\n${HOST}/live/${USER}/${PASS}/${c.id}.ts\n`
    return res.end(m3u)
  }
  const m = /^\/(live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.\w+$/.exec(p)
  if (m) return stream(req, res, m[1], [m[2], m[3], m[4]])
  const ts = /^\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/([^/]+)\/(\d+)\.\w+$/.exec(p)
  if (ts) return stream(req, res, 'timeshift', [ts[1], ts[2]])

  json(res, { error: 'not found' }, 404)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Tenvy test provider on ${HOST}  (username ${USER}, password ${PASS})`)
  console.log(`Control: ${HOST}/__control?drop=1 | stall=1 | fail=3 | down=1 | expired=1 | max=2 | reset=1`)
})
