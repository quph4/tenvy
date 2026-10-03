import { Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import { ASPECTS, applyAspect, savedAspect, streamInfo, type Aspect, type StreamInfo } from '../../lib/picture'
import { usePlayback } from '../../stores/playback'
import { useSleep } from '../../stores/sleep'
import { useNowPlaying } from '../../stores/nowPlaying'
import { hhmm } from '../../lib/time'

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]
const SLEEP = [15, 30, 60, 90]

/** Drawer: picture shape, sync fixes, speed, sleep timer and stream info. */
export function PicturePanel({ onClose }: { onClose(): void }) {
  const channel = usePlayback((s) => s.channel)
  const hasSubs = usePlayback((s) => s.currentSubtitle != null)
  const isVod = channel?.kind === 'movie' || channel?.kind === 'series'
  const [aspect, setAspect] = useState<Aspect>(savedAspect())
  const [info, setInfo] = useState<StreamInfo | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => streamInfo().then((i) => alive && setInfo(i)).catch(() => {})
    load()
    const t = window.setInterval(load, 2000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [channel?.id])

  const adjust = async (name: 'audio-delay' | 'sub-delay' | 'speed', value: number) => {
    await ipc.mpvAdjust(name, Math.round(value * 100) / 100).catch(() => {})
    setInfo(await streamInfo().catch(() => info))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-800/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        <span>Picture & sound</span>
        <button onClick={onClose} className="grid h-5 w-5 place-items-center rounded text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-200" aria-label="Close">
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 text-sm">
        <Section title="Picture" hint="A cycles">
          <div className="grid grid-cols-5 gap-1">
            {ASPECTS.map((a) => (
              <Chip
                key={a.id}
                active={aspect === a.id}
                onClick={() => {
                  setAspect(a.id)
                  applyAspect(a.id)
                }}
              >
                {a.label}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title="Audio delay" hint="if sound and picture drift">
          <Stepper value={info?.audioDelay ?? 0} onChange={(v) => adjust('audio-delay', v)} />
        </Section>

        {hasSubs && (
          <Section title="Subtitle delay">
            <Stepper value={info?.subDelay ?? 0} onChange={(v) => adjust('sub-delay', v)} />
          </Section>
        )}

        {isVod && (
          <Section title="Speed">
            <div className="grid grid-cols-5 gap-1">
              {SPEEDS.map((s) => (
                <Chip key={s} active={Math.abs((info?.speed ?? 1) - s) < 0.01} onClick={() => adjust('speed', s)}>
                  {s}×
                </Chip>
              ))}
            </div>
          </Section>
        )}

        <SleepSection />

        <Section title="Stream" hint="I shows it on screen">
          <dl className="space-y-1 text-xs">
            <Info label="Video" value={info?.video} />
            <Info label="Audio" value={info?.audio} />
            <Info label="Decoding" value={info?.video ? info.decoding : null} />
            <Info label="Bitrate" value={info?.bitrate} />
            <Info label="Buffer" value={info?.buffer} />
          </dl>
        </Section>
      </div>
    </div>
  )
}

function SleepSection() {
  const { endsAt, set, untilEpoch } = useSleep()
  const channel = usePlayback((s) => s.channel)
  const now = useNowPlaying(channel?.kind === 'live' ? channel.tvgId : null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (endsAt == null) return
    const t = window.setInterval(() => tick((n) => n + 1), 15_000)
    return () => window.clearInterval(t)
  }, [endsAt])
  const left = endsAt != null ? Math.max(1, Math.round((endsAt - Date.now()) / 60_000)) : null
  return (
    <Section title="Sleep timer" hint={left != null ? `stops in ${left} min` : undefined}>
      <div className="grid grid-cols-5 gap-1">
        <Chip active={endsAt == null} onClick={() => set(null)}>Off</Chip>
        {SLEEP.map((m) => (
          <Chip key={m} active={false} onClick={() => set(m)}>
            {m}m
          </Chip>
        ))}
      </div>
      {now && (
        <button
          onClick={() => untilEpoch(now.stop)}
          className="mt-1.5 w-full rounded-md border border-neutral-800 px-2 py-1.5 text-left text-xs text-neutral-300 hover:border-neutral-700"
        >
          When "{now.title}" ends ({hhmm(now.stop)})
        </button>
      )}
    </Section>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{title}</span>
        {hint && <span className="text-[10px] text-neutral-600">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md px-1 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-accent-400 text-neutral-950' : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800',
      )}
    >
      {children}
    </button>
  )
}

function Stepper({ value, onChange }: { value: number; onChange(v: number): void }) {
  const fmt = (v: number) => `${v > 0 ? '+' : ''}${(v * 1000).toFixed(0)} ms`
  return (
    <div className="flex items-center gap-1">
      <StepButton onClick={() => onChange(value - 0.1)} label="Earlier"><Minus className="h-3.5 w-3.5" /></StepButton>
      <span className="flex-1 text-center text-xs tabular-nums text-neutral-200">{fmt(value)}</span>
      <StepButton onClick={() => onChange(value + 0.1)} label="Later"><Plus className="h-3.5 w-3.5" /></StepButton>
      <StepButton onClick={() => onChange(0)} label="Reset"><RotateCcw className="h-3.5 w-3.5" /></StepButton>
    </div>
  )
}

function StepButton({ children, onClick, label }: { children: React.ReactNode; onClick(): void; label: string }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="grid h-7 w-7 place-items-center rounded-md bg-neutral-900 text-neutral-300 hover:bg-neutral-800">
      {children}
    </button>
  )
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="truncate text-right text-neutral-200">{value ?? '—'}</dd>
    </div>
  )
}
