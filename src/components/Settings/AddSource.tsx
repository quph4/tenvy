import { Link2, X } from 'lucide-react'
import { useState } from 'react'
import { useUI } from '../../stores/ui'
import { ipc } from '../../lib/ipc'
import { usePlaylist } from '../../stores/playlist'
import { useIngest } from '../../stores/ingest'
import { useToast } from '../../stores/toast'
import { cn } from '../../lib/cn'

type Tab = 'm3u' | 'xtream' | 'xmltv'

export function AddSource() {
  const { addSourceOpen, closeAddSource } = useUI()
  const { hydrate } = usePlaylist()
  const { push } = useToast()

  const [tab, setTab] = useState<Tab>('m3u')
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  if (!addSourceOpen) return null

  const submit = async () => {
    if (!name || !url) {
      push('error', 'Name and URL are required.')
      return
    }
    setBusy(true)
    // Id is unknown until the command returns; seed with -1 and let the
    // ingest listener adopt the real id from the first progress event.
    useIngest.getState().begin(-1, name)
    try {
      await ipc.addSource({
        kind: tab,
        name,
        url,
        username: tab === 'xtream' ? username : undefined,
        password: tab === 'xtream' ? password : undefined,
      })
      push('success', `Added ${name}`)
      await hydrate()
      closeAddSource()
      setName('')
      setUrl('')
      setUsername('')
      setPassword('')
    } catch (e) {
      push('error', String(e))
    } finally {
      setBusy(false)
      useIngest.getState().end()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={closeAddSource}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">Add playlist source</h2>
          <button
            onClick={closeAddSource}
            className="grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-3 border-b border-neutral-800 bg-neutral-950/60 text-xs">
          {(['m3u', 'xtream', 'xmltv'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'py-2 font-medium transition-colors',
                tab === t ? 'bg-neutral-900 text-accent-400' : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {labelFor(t)}
            </button>
          ))}
        </div>

        <div className="space-y-3 p-5">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Provider"
              className="input"
            />
          </Field>

          {tab === 'm3u' && (
            <Field label="M3U URL or file path" hint="Remote URL (http/https) or local .m3u file.">
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/playlist.m3u"
                  className="input pl-8"
                />
              </div>
            </Field>
          )}

          {tab === 'xtream' && (
            <>
              <Field label="Host" hint="Just the base URL — e.g. http://iptv.example.com:8080">
                <input value={url} onChange={(e) => setUrl(e.target.value)} className="input" />
              </Field>
              <Field label="Username">
                <input value={username} onChange={(e) => setUsername(e.target.value)} className="input" />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input"
                />
              </Field>
            </>
          )}

          {tab === 'xmltv' && (
            <Field label="XMLTV EPG URL" hint=".xml or .xml.gz — attaches to existing channels by tvg-id.">
              <input value={url} onChange={(e) => setUrl(e.target.value)} className="input" />
            </Field>
          )}

          <div className="flex items-center gap-2 pt-2">
            <button
              disabled={busy}
              onClick={submit}
              className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-accent-400 text-sm font-semibold text-neutral-950 shadow-sm transition-colors hover:bg-accent-300 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add source'}
            </button>
            <button
              onClick={closeAddSource}
              className="inline-flex h-9 items-center justify-center rounded-md border border-neutral-800 px-4 text-sm text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .input {
          width: 100%;
          height: 36px;
          border-radius: 6px;
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
    </div>
  )
}

function labelFor(t: Tab): string {
  return t === 'm3u' ? 'M3U' : t === 'xtream' ? 'Xtream' : 'XMLTV EPG'
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-neutral-600">{hint}</span>}
    </label>
  )
}
