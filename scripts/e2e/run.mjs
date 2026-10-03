// End-to-end test run: starts the local test provider and Tenvy (dev build)
// against a fresh, separate library, then drives the app through its own
// UI and stores (see tests.mjs). Sound is muted; nothing touches your own
// library or provider.
//
//   node scripts/e2e/run.mjs            all tests
//   node scripts/e2e/run.mjs Guide      setup + tests whose name contains "Guide"
//
// Results: scripts/e2e/out/results.json, plus a screenshot per failure.

import { spawn, execSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tests } from './tests.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT = join(HERE, 'out')
const DATA = join(tmpdir(), `tenvy-e2e-${Date.now()}`)
const CDP_PORT = 9333
const PROVIDER = 'http://127.0.0.1:8788'
const only = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
mkdirSync(join(DATA, 'webview'), { recursive: true })

const children = []
function start(cmd, args, env = {}, log = null) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const sink = log ? createWriteStream(join(OUT, log)) : null
  p.stdout.on('data', (d) => sink?.write(d))
  p.stderr.on('data', (d) => sink?.write(d))
  children.push(p)
  return p
}

function cleanup() {
  for (const p of children) {
    try {
      execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  }
  // The dev build's own processes (never an installed Tenvy).
  try {
    execSync(
      `powershell -NoProfile -Command "Get-Process tenvy, mpv -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*target\\debug*' } | Stop-Process -Force"`,
      { stdio: 'ignore' },
    )
  } catch {
    /* none */
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

// ---------- CDP ----------

class Page {
  async connect() {
    for (let i = 0; i < 600; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
        const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:1420'))
        if (page) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((r, j) => {
            this.ws.addEventListener('open', r)
            this.ws.addEventListener('error', j)
          })
          this.seq = 0
          this.pending = new Map()
          this.ws.addEventListener('message', (m) => {
            const d = JSON.parse(m.data)
            if (d.id && this.pending.has(d.id)) {
              this.pending.get(d.id)(d)
              this.pending.delete(d.id)
            }
          })
          return
        }
      } catch {
        /* not up yet */
      }
      await sleep(1000)
    }
    throw new Error('the app never came up')
  }
  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((r) => this.pending.set(id, r))
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const ex = r.result?.exceptionDetails
    if (ex) throw new Error(ex.exception?.description?.split('\n')[0] ?? ex.text)
    return r.result?.result?.value
  }
  async injectHelpers() {
    await this.eval(readFileSync(join(HERE, 'page-helpers.js'), 'utf8'))
    await this.eval('new Promise((r) => setTimeout(r, 300))')
  }
  async run(fn, args) {
    return this.eval(`(${fn.toString()})(window.__t, ${JSON.stringify(args ?? null)})`)
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
}

// ---------- run ----------

console.log(`library: ${DATA}`)
console.log('starting test provider…')
start('node', [join('scripts', 'test-provider', 'server.mjs')], {}, 'provider.log')
for (let i = 0; i < 120; i++) {
  try {
    await fetch(`${PROVIDER}/__status`)
    break
  } catch {
    await sleep(500)
  }
}
await fetch(`${PROVIDER}/__control?reset=1`)

console.log('starting Tenvy (dev build; first run compiles)…')
start('pnpm', ['tauri', 'dev'], {
  TENVY_DATA_DIR: DATA,
  TENVY_MUTE: '1',
  TENVY_CONFIG_URL: `${PROVIDER}/config.json`,
  WEBVIEW2_USER_DATA_FOLDER: join(DATA, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
}, 'app.log')

const page = new Page()
await page.connect()
await sleep(4000)
await page.injectHelpers()

const ctx = {
  page: (fn, args) => page.run(fn, args),
  control: (q) => fetch(`${PROVIDER}/__control?${q}`).then((r) => r.json()),
  reload: async () => {
    await page.eval('location.reload()').catch(() => {})
    await sleep(5000)
    await page.injectHelpers()
  },
  killMpv: async () => {
    execSync(
      `powershell -NoProfile -Command "Get-Process mpv -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*target\\debug*' -or $_.Path -like '*resources\\mpv*' } | Stop-Process -Force"`,
      { stdio: 'ignore' },
    )
  },
}

const results = []
for (const [i, test] of tests.entries()) {
  // The first test connects the provider; the rest build on it.
  if (only && i > 0 && !test.name.toLowerCase().includes(only.toLowerCase())) continue
  const t0 = Date.now()
  let ok = true
  let note = ''
  try {
    await page.run(async (t) => t.reset())
    note = (await test.run(ctx)) ?? ''
    // Whatever the test did, the app must still agree with itself.
    const problems = await page.run(async (t) => t.consistency())
    if (problems.length) throw new Error(`inconsistent afterwards: ${problems.join('; ')}`)
  } catch (e) {
    ok = false
    note = String(e.message ?? e)
    await page.screenshot(join(OUT, `fail-${results.length + 1}.png`)).catch(() => {})
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  results.push({ name: test.name, ok, secs, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${test.name}  (${secs}s)${note ? `  — ${note}` : ''}`)
}

writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
await page.run(async (t) => t.stop()).catch(() => {})
cleanup()
rmSync(DATA, { recursive: true, force: true, maxRetries: 3 })
process.exit(failed ? 1 : 0)
