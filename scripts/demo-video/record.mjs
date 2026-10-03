// Records a short Tenvy demo from the dev demo mode (?demo) with headless
// Chrome: scripted clicks with a visible cursor, captions and title cards.
// Frames + timestamps go to ./out; build.py turns them into an MP4.
//
//   pnpm dev                       (in another terminal)
//   node scripts/demo-video/record.mjs
//   python scripts/demo-video/build.py --encode   -> out/tenvy-demo.mp4
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const OUT = join(DIR, 'out')
const FRAMES = join(OUT, 'frames')
rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })

const W = 1600, H = 900, SCALE = 1.2 // → 1920×1080
const PORT = 9333
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`,
  `--user-data-dir=${join(OUT, 'profile')}`, 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let targets
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break } catch { await sleep(200) }
}
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))

let seq = 0
const pending = new Map()
const frames = []
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return }
  if (d.method === 'Page.screencastFrame') {
    const { data, metadata, sessionId } = d.params
    const name = `f${String(frames.length).padStart(5, '0')}.jpg`
    writeFileSync(join(FRAMES, name), Buffer.from(data, 'base64'))
    frames.push({ name, t: metadata.timestamp })
    send('Page.screencastFrameAck', { sessionId })
  }
})
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((r) => pending.set(id, r))
}
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
// Exact 1600×900 CSS viewport at 1.2× → 1920×1080 frames.
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false })
await send('Page.navigate', { url: 'http://localhost:1420/?demo' })
await sleep(3500)
await js(readFileSync(join(DIR, 'overlay.js'), 'utf8'))
await sleep(300)

// ---- input helpers ----
let cursor = { x: W * 0.62, y: H * 0.55 }
async function moveTo(x, y, ms = 700) {
  await js(`__d.cursorTo(${x}, ${y}, ${ms})`)
  // Hover events along the way, so hover styles light up.
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const px = cursor.x + ((x - cursor.x) * i) / steps
    const py = cursor.y + ((y - cursor.y) * i) / steps
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py })
    await sleep(ms / steps)
  }
  cursor = { x, y }
}
async function clickAt(x, y) {
  await moveTo(x, y)
  await sleep(150)
  await js('__d.ripple()')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
async function click(finder) {
  let p = null
  for (let i = 0; i < 30 && !p; i++) {
    p = await js(finder)
    if (!p) await sleep(100)
  }
  if (!p) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, 'fail.png'), Buffer.from(shot.result.data, 'base64'))
    chrome.kill()
    throw new Error('not found: ' + finder)
  }
  await clickAt(p.x, p.y)
}
async function key(k, opts = {}) {
  const code = opts.code ?? (k.length === 1 ? 'Key' + k.toUpperCase() : k)
  const base = { key: k, code, modifiers: opts.ctrl ? 2 : 0, windowsVirtualKeyCode: opts.vk ?? k.toUpperCase().charCodeAt(0) }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
async function type(text, gap = 110) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, code: 'Key' + ch.toUpperCase() })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase() })
    await sleep(gap)
  }
}
const caption = (t) => js(`__d.caption(${JSON.stringify(t)})`)

// ---- storyboard ----
await js('__d.titleCard(true)')
// Warm up artwork behind the title card so posters don't pop in later.
await js(`(async () => {
  const pl = (await import('/src/stores/playlist.ts')).usePlaylist
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await pl.getState().setActiveKind('movie'); await wait(1200)
  await pl.getState().setActiveKind('series'); await wait(1000)
  await pl.getState().setActiveKind('live'); await wait(600)
  ;(await import('/src/stores/ui.ts')).useUI.getState().setView('epg'); await wait(800)
})()`)
await js('__d.titleCard(true)')
await sleep(600)
await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
await sleep(3200)

// 1. Guide
await js(`(async () => { (await import('/src/stores/ui.ts')).useUI.getState().setView('epg') })()`)
await sleep(400)
await js('__d.titleCard(false)')
await sleep(700)
await caption('A real TV guide for your IPTV')
await sleep(1600)
await click(`__d.programme('Arena Sport 1', 1)`)
await sleep(1200)
await caption('Catch-up, start over and reminders')
await click(`__d.byText('Remind me', 'button')`)
await sleep(1800)
await key('Escape', { vk: 27 })
await sleep(600)

// 2. Search
await caption('Find anything, instantly')
await moveTo(W * 0.3, 34)
await key('k', { ctrl: true, vk: 75 })
await sleep(700)
await type('harbour')
await sleep(1800)
await key('Escape', { vk: 27 })
await sleep(500)

// 3. Movies
await caption('Films and series, finally browsable')
await click(`__d.byText('Movies', 'button')`)
await sleep(1600)
await js('__d.scrollMain(420, 1600)')
await sleep(1900)
await js('__d.scrollMain(-420, 1200)')
await sleep(1500)

// 4. Details
await caption('Pick up right where you left off')
await click(`__d.byText('Midnight Orchard', 'div, span, p')`)
await sleep(2800)

// 5. Series
await caption('Every season, every episode')
await click(`__d.byText('Shows', 'button')`)
await sleep(1200)
await click(`__d.byText('Coldwater', 'div, span, p')`)
await sleep(1200)
await click(`__d.byText('Season 2', 'button')`)
await sleep(2200)

// 6. End card
await js('__d.caption(null)')
await js('__d.endCard()')
await sleep(3800)

await send('Page.stopScreencast')
await sleep(300)
writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames))
console.log(`${frames.length} frames over ${(frames.at(-1).t - frames[0].t).toFixed(1)}s`)
ws.close()
chrome.kill()
process.exit(0)
