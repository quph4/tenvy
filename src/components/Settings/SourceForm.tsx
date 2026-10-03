import { Eye, EyeOff, Link2, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import { useIngest } from '../../stores/ingest'
import type { Source } from '../../types'

type Tab = 'xtream' | 'm3u' | 'xmltv'

const TAB_LABEL: Record<Tab, string> = {
  xtream: 'Xtream Codes',
  m3u: 'M3U link',
  xmltv: 'XMLTV guide',
}

/**
 * Connect a provider: Xtream login (recommended), an M3U link, or — in
 * the full form — an extra XMLTV guide. Shared by the first-run page and
 * the "Add playlist" dialog. Errors show inline, next to the fields.
 */
export function SourceForm({
  onAdded,
  allowGuide = true,
  submitLabel = 'Connect',
}: {
  onAdded(source: Source): void
  /** Offer the XMLTV-only tab (not useful before any channels exist). */
  allowGuide?: boolean
  submitLabel?: string
}) {
  const [tab, setTab] = useState<Tab>('xtream')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tabs: Tab[] = allowGuide ? ['xtream', 'm3u', 'xmltv'] : ['xtream', 'm3u']

  // Pasting a full get.php / player_api link into the server field fills
  // in all three Xtream fields.
  const onServerChange = (value: string) => {
    const parsed = parseXtreamLink(value)
    if (parsed) {
      setUrl(parsed.host)
      setUsername(parsed.username)
      setPassword(parsed.password)
    } else {
      setUrl(value)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const target = url.trim()
    if (!target) return setError(tab === 'xtream' ? 'Enter the server address.' : 'Enter the link.')
    if (tab === 'xtream' && (!username.trim() || !password)) return setError('Enter your username and password.')

    const displayName = name.trim() || defaultName(target)
    setBusy(true)
    // Id is unknown until the command returns; seed with -1 and let the
    // ingest listener adopt the real id from the first progress event.
    useIngest.getState().begin(-1, displayName)
    try {
      const source = await ipc.addSource({
        kind: tab,
        name: displayName,
        url: target,
        username: tab === 'xtream' ? username.trim() : undefined,
        password: tab === 'xtream' ? password : undefined,
      })
      onAdded(source)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setBusy(false)
      useIngest.getState().end()
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex gap-1 rounded-lg bg-neutral-950/70 p-1 text-xs">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t)
              setError(null)
            }}
            className={cn(
              'flex-1 rounded-md py-1.5 font-medium transition-colors',
              tab === t ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300',
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'xtream' && (
        <>
          <Field label="Server" hint="From your provider, e.g. http://line.example.com:8080 — or paste a full link.">
            <input
              value={url}
              onChange={(e) => onServerChange(e.target.value)}
              placeholder="http://server:port"
              className="input"
              autoFocus
              spellCheck={false}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input"
                autoComplete="username"
                spellCheck={false}
              />
            </Field>
            <Field label="Password">
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pr-9"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          </div>
        </>
      )}

      {tab === 'm3u' && (
        <Field label="Playlist link" hint="An M3U/M3U8 URL, or the path to a file on this PC.">
          <div className="relative">
            <Link2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://provider.example/playlist.m3u"
              className="input pl-8"
              autoFocus
              spellCheck={false}
            />
          </div>
        </Field>
      )}

      {tab === 'xmltv' && (
        <Field label="Guide link" hint=".xml or .xml.gz — matched to your channels by id and name.">
          <input value={url} onChange={(e) => setUrl(e.target.value)} className="input" autoFocus spellCheck={false} />
        </Field>
      )}

      <Field label="Name (optional)">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={url ? defaultName(url) : 'My provider'}
          className="input"
        />
      </Field>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent-400 text-sm font-semibold text-neutral-950 transition-colors hover:bg-accent-300 disabled:opacity-60"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? 'Connecting…' : submitLabel}
      </button>

      <style>{`
        .input {
          width: 100%;
          height: 38px;
          border-radius: 8px;
          border: 1px solid rgb(38 38 38);
          background: rgb(10 10 10);
          padding: 0 10px;
          font-size: 13px;
          color: rgb(245 245 245);
          outline: none;
          transition: border-color 150ms;
        }
        .input:focus { border-color: #D4B47C; }
        .input::placeholder { color: rgb(82 82 82); }
      `}</style>
    </form>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-neutral-600">{hint}</span>}
    </label>
  )
}

/** "line.example.com:8080" → "line.example.com"; files → their name. */
function defaultName(target: string): string {
  try {
    const u = new URL(target.includes('://') ? target : `http://${target}`)
    return u.hostname.replace(/^www\./, '') || 'My provider'
  } catch {
    return target.split(/[\\/]/).pop() || 'My provider'
  }
}

/** Split a pasted Xtream link (get.php / player_api.php with credentials). */
function parseXtreamLink(value: string): { host: string; username: string; password: string } | null {
  if (!/username=/.test(value) || !/password=/.test(value)) return null
  try {
    const u = new URL(value.trim())
    const username = u.searchParams.get('username')
    const password = u.searchParams.get('password')
    if (!username || !password) return null
    return { host: `${u.protocol}//${u.host}`, username, password }
  } catch {
    return null
  }
}
