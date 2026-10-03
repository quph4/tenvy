import { Lock, LockOpen, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useParental } from '../../stores/parental'
import { useUI } from '../../stores/ui'
import { PinInput } from '../PinPrompt'

/** Settings: categories and the parental PIN. */
export function ParentalSection() {
  const { status, lock } = useParental()
  const [mode, setMode] = useState<null | 'set' | 'remove'>(null)

  return (
    <div className="border-t border-neutral-800 p-5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Categories & parental lock</span>
      <button
        onClick={() => useUI.getState().setManageCategories(true)}
        className="mt-3 flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2.5 text-left hover:border-neutral-700"
      >
        <SlidersHorizontal className="h-4 w-4 shrink-0 text-accent-400" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-neutral-200">Manage categories</span>
          <span className="block text-[11px] text-neutral-500">Hide the ones you never watch, lock the ones kids shouldn't.</span>
        </span>
      </button>

      <div className="mt-3 flex items-center gap-3">
        {status.pinSet && !status.unlocked ? (
          <Lock className="h-4 w-4 shrink-0 text-accent-400" />
        ) : (
          <LockOpen className="h-4 w-4 shrink-0 text-neutral-500" />
        )}
        <div className="min-w-0 flex-1 text-[11px] text-neutral-500">
          {!status.pinSet
            ? 'No parental PIN. Set one to lock categories.'
            : status.unlocked
              ? 'PIN set. Locked categories are open until you lock them again.'
              : 'PIN set. Locked categories are hidden.'}
        </div>
      </div>

      {mode ? (
        <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
          {mode === 'set' ? <PinSetup onDone={() => setMode(null)} onCancel={() => setMode(null)} /> : <PinRemove onDone={() => setMode(null)} />}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <SmallButton onClick={() => setMode('set')}>{status.pinSet ? 'Change PIN' : 'Set PIN'}</SmallButton>
          {status.pinSet && <SmallButton onClick={() => setMode('remove')}>Remove PIN</SmallButton>}
          {status.pinSet && status.unlocked && <SmallButton onClick={() => lock().catch(() => {})}>Lock now</SmallButton>}
        </div>
      )}
    </div>
  )
}

/** Create or change the PIN (asks for the current one when changing). */
export function PinSetup({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const { status, setPin } = useParental()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (next.length < 4) return setError('Use 4 to 8 digits.')
    if (next !== again) return setError("The PINs don't match.")
    try {
      await setPin(status.pinSet ? current : null, next)
      onDone()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  return (
    <form onSubmit={save} className="space-y-2">
      {status.pinSet && <Labeled label="Current PIN"><PinInput value={current} onChange={setCurrent} /></Labeled>}
      <Labeled label="New PIN"><PinInput value={next} onChange={(v) => { setNext(v); setError(null) }} /></Labeled>
      <Labeled label="Repeat new PIN"><PinInput value={again} onChange={(v) => { setAgain(v); setError(null) }} /></Labeled>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onCancel} className="h-8 flex-1 rounded-md border border-neutral-800 text-xs text-neutral-300 hover:border-neutral-700">
          Cancel
        </button>
        <button type="submit" className="h-8 flex-1 rounded-md bg-accent-400 text-xs font-semibold text-neutral-950 hover:bg-accent-300">
          Save PIN
        </button>
      </div>
    </form>
  )
}

function PinRemove({ onDone }: { onDone(): void }) {
  const setPin = useParental((s) => s.setPin)
  const [current, setCurrent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const remove = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await setPin(current, null)
      onDone()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }
  return (
    <form onSubmit={remove} className="space-y-2">
      <Labeled label="Current PIN"><PinInput value={current} onChange={(v) => { setCurrent(v); setError(null) }} /></Labeled>
      <p className="text-[11px] text-neutral-500">Without a PIN, locked categories show for everyone.</p>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onDone} className="h-8 flex-1 rounded-md border border-neutral-800 text-xs text-neutral-300 hover:border-neutral-700">
          Cancel
        </button>
        <button type="submit" className="h-8 flex-1 rounded-md bg-red-500/80 text-xs font-semibold text-white hover:bg-red-500">
          Remove PIN
        </button>
      </div>
    </form>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{label}</span>
      <div className="-mt-2">{children}</div>
    </label>
  )
}

function SmallButton({ children, onClick }: { children: React.ReactNode; onClick(): void }) {
  return (
    <button onClick={onClick} className="inline-flex h-7 items-center rounded-md border border-neutral-800 px-2.5 text-xs text-neutral-300 hover:border-neutral-700">
      {children}
    </button>
  )
}
