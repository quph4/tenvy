import { Lock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParental } from '../stores/parental'

/** Asks for the parental PIN when locked content is opened. */
export function PinPrompt() {
  const prompt = useParental((s) => s.prompt)
  if (!prompt) return null
  return <PinDialog reason={prompt.reason} />
}

function PinDialog({ reason }: { reason: string }) {
  const { submit, cancel } = useParental()
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || pin.length < 4) return
    setBusy(true)
    const ok = await submit(pin).catch(() => false)
    setBusy(false)
    if (!ok) {
      setError(true)
      setPin('')
      input.current?.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in" onClick={cancel}>
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            cancel()
          }
        }}
        className="w-full max-w-xs rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-center shadow-2xl shadow-black/60"
      >
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-accent-400/10">
          <Lock className="h-5 w-5 text-accent-400" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-white">Enter PIN</h2>
        <p className="mt-1 text-sm text-neutral-500">{reason}</p>
        <PinInput ref={input} value={pin} onChange={(v) => { setPin(v); setError(false) }} />
        {error && <p className="mt-2 text-xs text-red-300">That PIN isn't right.</p>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={cancel} className="h-9 flex-1 rounded-lg border border-neutral-800 text-sm text-neutral-300 hover:border-neutral-700">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || pin.length < 4}
            className="h-9 flex-1 rounded-lg bg-accent-400 text-sm font-semibold text-neutral-950 hover:bg-accent-300 disabled:opacity-50"
          >
            Unlock
          </button>
        </div>
      </form>
    </div>
  )
}

/** Digits-only, masked PIN field. */
export function PinInput({
  value,
  onChange,
  ref,
  placeholder = '••••',
}: {
  value: string
  onChange(v: string): void
  ref?: React.Ref<HTMLInputElement>
  placeholder?: string
}) {
  return (
    <input
      ref={ref}
      type="password"
      inputMode="numeric"
      autoComplete="off"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 8))}
      className="mt-4 h-11 w-full rounded-lg border border-neutral-800 bg-neutral-950 text-center text-xl tracking-[0.5em] text-neutral-100 outline-none placeholder:text-neutral-700 focus:border-accent-400"
    />
  )
}
