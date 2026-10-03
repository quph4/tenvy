import { cn } from '../../lib/cn'
import type { MpvTrack } from '../../types'

export interface TrackOption {
  id: string
  label: string
  active: boolean
}

export function TrackPanel({
  label,
  options,
  emptyHint,
  onSelect,
  onClose,
}: {
  label: string
  options: TrackOption[]
  emptyHint?: string
  onSelect(id: string): void
  onClose(): void
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        <span>{label}</span>
        <button
          onClick={onClose}
          className="grid h-5 w-5 place-items-center rounded text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1 text-sm">
        {options.length === 0 ? (
          <div className="px-3 py-4 text-xs text-zinc-500">
            {emptyHint ?? 'Nothing available.'}
          </div>
        ) : (
          options.map((o) => (
            <button
              key={o.id}
              onClick={() => onSelect(o.id)}
              className={cn(
                'flex w-full items-center justify-between gap-4 px-3 py-2 text-left',
                o.active
                  ? 'bg-indigo-500/10 text-indigo-300'
                  : 'text-zinc-200 hover:bg-zinc-800/60',
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.active && <span className="text-xs">●</span>}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export function formatTrack(t: MpvTrack, index: number, audio: boolean): string {
  const parts: string[] = []
  const lang = prettyLang(t.lang)
  if (lang) parts.push(lang)
  if (t.title && !parts.some((p) => p.toLowerCase() === t.title!.toLowerCase())) {
    parts.push(t.title)
  }
  if (t.codec) parts.push(t.codec.toUpperCase())
  if (audio && t.channels) {
    parts.push(
      t.channels === 1 ? 'Mono' : t.channels === 2 ? 'Stereo' : `${t.channels}ch`,
    )
  }
  if (parts.length === 0) parts.push(`Track ${index + 1}`)
  if (t.default) parts.push('(default)')
  return parts.join(' · ')
}

function prettyLang(code: string | null): string | null {
  if (!code) return null
  const c = code.toLowerCase()
  const map: Record<string, string> = {
    eng: 'English', en: 'English',
    spa: 'Spanish', es: 'Spanish',
    fre: 'French', fra: 'French', fr: 'French',
    ger: 'German', deu: 'German', de: 'German',
    ita: 'Italian', it: 'Italian',
    por: 'Portuguese', pt: 'Portuguese',
    rus: 'Russian', ru: 'Russian',
    jpn: 'Japanese', ja: 'Japanese',
    kor: 'Korean', ko: 'Korean',
    chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
    ara: 'Arabic', ar: 'Arabic',
    hin: 'Hindi', hi: 'Hindi',
    tur: 'Turkish', tr: 'Turkish',
    nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
    swe: 'Swedish', sv: 'Swedish',
    nor: 'Norwegian', no: 'Norwegian',
    dan: 'Danish', da: 'Danish',
    fin: 'Finnish', fi: 'Finnish',
    pol: 'Polish', pl: 'Polish',
    ces: 'Czech', cze: 'Czech', cs: 'Czech',
    hun: 'Hungarian', hu: 'Hungarian',
    ron: 'Romanian', rum: 'Romanian', ro: 'Romanian',
    ell: 'Greek', gre: 'Greek', el: 'Greek',
    heb: 'Hebrew', he: 'Hebrew',
    tha: 'Thai', th: 'Thai',
    vie: 'Vietnamese', vi: 'Vietnamese',
    ind: 'Indonesian', id: 'Indonesian',
    und: 'Unknown',
  }
  return map[c] ?? code.toUpperCase()
}
