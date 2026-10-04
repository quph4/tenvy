import { create } from 'zustand'
import { osd } from '../lib/osd'
import { usePlayback } from './playback'
import { useToast } from './toast'

/**
 * Sleep timer: stop playback after a while, or when the programme on now
 * ends. A minute's warning on screen first.
 */
interface SleepState {
  /** Epoch ms when playback stops, or null. */
  endsAt: number | null
  set(minutes: number | null): void
  /** Stop when this programme ends (epoch seconds). */
  untilEpoch(stop: number): void
}

let timer: number | undefined
let warnTimer: number | undefined

function arm(endsAt: number | null) {
  window.clearTimeout(timer)
  window.clearTimeout(warnTimer)
  if (endsAt == null) return
  const ms = endsAt - Date.now()
  warnTimer = window.setTimeout(() => osd('Sleep timer: stopping in 1 minute', 6000), Math.max(0, ms - 60_000))
  timer = window.setTimeout(() => {
    useSleep.setState({ endsAt: null })
    usePlayback.getState().stop()
    useToast.getState().push('info', 'Sleep timer: playback stopped.')
  }, Math.max(0, ms))
}

// The timer belongs to what was playing when it was set: switching to
// something else (or stopping) cancels it.
let boundTo: number | null = null
usePlayback.subscribe((s, prev) => {
  if (boundTo == null) return
  if (s.channel?.id !== prev.channel?.id && s.channel?.id !== boundTo) {
    boundTo = null
    window.clearTimeout(timer)
    window.clearTimeout(warnTimer)
    useSleep.setState({ endsAt: null })
  }
})

export const useSleep = create<SleepState>((set) => ({
  endsAt: null,
  set(minutes) {
    const endsAt = minutes == null ? null : Date.now() + minutes * 60_000
    boundTo = minutes == null ? null : usePlayback.getState().channel?.id ?? null
    set({ endsAt })
    arm(endsAt)
    osd(minutes == null ? 'Sleep timer off' : `Sleep timer: ${minutes} min`, 1500)
  },
  untilEpoch(stop) {
    const endsAt = stop * 1000
    boundTo = usePlayback.getState().channel?.id ?? null
    set({ endsAt })
    arm(endsAt)
    const d = new Date(endsAt)
    osd(`Sleep timer: ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`, 1500)
  },
}))
