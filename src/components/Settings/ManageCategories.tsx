import { Eye, EyeOff, Lock, LockOpen, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import { useParental } from '../../stores/parental'
import { usePlaylist } from '../../stores/playlist'
import { useToast } from '../../stores/toast'
import { useUI } from '../../stores/ui'
import type { ChannelKind, Group } from '../../types'
import { PinSetup } from './ParentalSection'

const KINDS: { kind: ChannelKind; label: string }[] = [
  { kind: 'live', label: 'Live TV' },
  { kind: 'movie', label: 'Movies' },
  { kind: 'series', label: 'Shows' },
]

const ADULT = /\b(adult|adults|xxx|18\+|porn|for adults)\b/i

/**
 * Choose which categories show up (hidden ones stay out of "All", search
 * and the sidebar) and which sit behind the parental PIN.
 */
export function ManageCategories() {
  const open = useUI((s) => s.manageCategoriesOpen)
  if (!open) return null
  return <Dialog />
}

function Dialog() {
  const close = () => useUI.getState().setManageCategories(false)
  const { sources, activeSourceId, activeKind } = usePlaylist()
  const push = useToast((s) => s.push)
  const [kind, setKind] = useState<ChannelKind>(activeKind)
  const [groups, setGroups] = useState<Group[]>([])
  const [filter, setFilter] = useState('')
  const [needPin, setNeedPin] = useState<string[] | null>(null)

  // Changes apply to the provider on screen, or to every provider when
  // all are shown together.
  const sourceIds = activeSourceId != null ? [activeSourceId] : sources.map((s) => s.id)

  const load = async () => setGroups(await ipc.listGroups(activeSourceId, kind))
  useEffect(() => {
    load().catch(() => setGroups([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, activeSourceId])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups
  }, [groups, filter])
  const hiddenCount = groups.filter((g) => g.hidden).length
  const adult = groups.filter((g) => ADULT.test(g.name) && !g.locked)

  const apply = async (names: string[], flags: { hidden?: boolean; locked?: boolean }) => {
    if (names.length === 0) return
    // Read fresh: a PIN may have been created a moment ago.
    if (flags.locked === true && !useParental.getState().status.pinSet) {
      setNeedPin(names)
      return
    }
    if (flags.locked === false && !(await useParental.getState().requireUnlocked('Enter the PIN to unlock categories.'))) return
    try {
      for (const sourceId of sourceIds) await ipc.setGroupPrefs({ sourceId, kind, names, ...flags })
      await load()
      // Refresh the sidebar and lists behind the dialog.
      const pl = usePlaylist.getState()
      if (pl.activeKind === kind) await pl.hydrate()
    } catch (e) {
      push('error', String(e).replace(/^Error:\s*/, ''))
    }
  }

  const names = (list: Group[]) => list.map((g) => g.name)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in" onClick={close}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            close()
          }
        }}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">Categories</h2>
          <button onClick={close} className="grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300" aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {needPin ? (
          <div className="p-5">
            <p className="mb-4 text-sm text-neutral-400">Create a parental PIN first. You'll need it to open locked categories.</p>
            <PinSetup
              onDone={async () => {
                const pending = needPin
                setNeedPin(null)
                await apply(pending, { locked: true })
              }}
              onCancel={() => setNeedPin(null)}
            />
          </div>
        ) : (
          <>
            <div className="space-y-3 border-b border-neutral-800 p-4">
              <div className="flex gap-1 rounded-lg bg-neutral-950/70 p-1 text-xs">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    onClick={() => setKind(k.kind)}
                    className={cn('flex-1 rounded-md py-1.5 font-medium', kind === k.kind ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300')}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter, e.g. Sweden"
                  className="h-9 w-full rounded-lg border border-neutral-800 bg-neutral-950 pl-8 pr-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-accent-400"
                />
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {filter.trim() ? (
                  <>
                    <Bulk onClick={() => apply(names(groups.filter((g) => !shown.includes(g))), { hidden: true }).then(() => apply(names(shown), { hidden: false }))}>
                      Show only these {shown.length}
                    </Bulk>
                    <Bulk onClick={() => apply(names(shown), { hidden: true })}>Hide these {shown.length}</Bulk>
                  </>
                ) : (
                  <>
                    <Bulk onClick={() => apply(names(groups), { hidden: false })}>Show all</Bulk>
                    <Bulk onClick={() => apply(names(groups), { hidden: true })}>Hide all</Bulk>
                  </>
                )}
                {adult.length > 0 && (
                  <Bulk accent onClick={() => apply(names(adult), { locked: true })}>
                    <Lock className="h-3 w-3" /> Lock {adult.length} adult {adult.length === 1 ? 'category' : 'categories'}
                  </Bulk>
                )}
              </div>
              <p className="text-[11px] text-neutral-500">
                {groups.length} categories · {hiddenCount} hidden. Hidden ones stay out of "All" and search; locked ones need the PIN.
              </p>
            </div>

            <ul className="min-h-0 flex-1 overflow-y-auto p-2">
              {shown.map((g) => (
                <li key={g.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-800/40">
                  <span className={cn('min-w-0 flex-1 truncate', g.hidden ? 'text-neutral-600 line-through decoration-neutral-700' : 'text-neutral-200')}>
                    {g.name}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-neutral-600">{g.count.toLocaleString()}</span>
                  <IconToggle
                    on={!g.hidden}
                    label={g.hidden ? 'Show' : 'Hide'}
                    onClick={() => apply([g.name], { hidden: !g.hidden })}
                  >
                    {g.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </IconToggle>
                  <IconToggle
                    on={g.locked}
                    accent
                    label={g.locked ? 'Unlock' : 'Lock'}
                    onClick={() => apply([g.name], { locked: !g.locked })}
                  >
                    {g.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                  </IconToggle>
                </li>
              ))}
              {shown.length === 0 && <li className="px-2 py-6 text-center text-xs text-neutral-600">No categories match.</li>}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

function Bulk({ children, onClick, accent }: { children: React.ReactNode; onClick(): void; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1',
        accent ? 'border-accent-500/40 text-accent-300 hover:bg-accent-400/10' : 'border-neutral-800 text-neutral-300 hover:border-neutral-700',
      )}
    >
      {children}
    </button>
  )
}

function IconToggle({
  on,
  accent,
  label,
  onClick,
  children,
}: {
  on: boolean
  accent?: boolean
  label: string
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-neutral-800',
        on ? (accent ? 'text-accent-400' : 'text-neutral-300') : 'text-neutral-600',
      )}
    >
      {children}
    </button>
  )
}
