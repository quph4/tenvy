import { ipc } from './ipc'
import { osd } from './osd'

/**
 * Picture shape and the stream info overlay. Shapes are mpv properties:
 * an aspect override, `panscan` (zoom-to-fill, cropping the edges) and
 * `keepaspect` (off = stretch to the window).
 */
export type Aspect = 'auto' | '16:9' | '4:3' | 'fill' | 'stretch'

export const ASPECTS: { id: Aspect; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: '16:9', label: '16:9' },
  { id: '4:3', label: '4:3' },
  { id: 'fill', label: 'Fill' },
  { id: 'stretch', label: 'Stretch' },
]

const KEY = 'tenvy.aspect'

export function savedAspect(): Aspect {
  try {
    const v = localStorage.getItem(KEY) as Aspect | null
    return ASPECTS.some((a) => a.id === v) ? v! : 'auto'
  } catch {
    return 'auto'
  }
}

export async function applyAspect(a: Aspect, announce = false) {
  try {
    localStorage.setItem(KEY, a)
  } catch {
    /* ignore */
  }
  await Promise.all([
    ipc.mpvAdjust('video-aspect-override', a === '16:9' || a === '4:3' ? a : '-1'),
    ipc.mpvAdjust('panscan', a === 'fill' ? 1 : 0),
    ipc.mpvAdjust('keepaspect', a !== 'stretch'),
  ]).catch(() => {})
  if (announce) osd(`Picture: ${ASPECTS.find((x) => x.id === a)!.label}`, 1500)
}

/** A key: step through the shapes. */
export function cycleAspect() {
  const i = ASPECTS.findIndex((a) => a.id === savedAspect())
  applyAspect(ASPECTS[(i + 1) % ASPECTS.length].id, true)
}

export interface StreamInfo {
  video: string | null
  audio: string | null
  decoding: string | null
  bitrate: string | null
  buffer: string | null
  audioDelay: number
  subDelay: number
  speed: number
}

type Raw = Record<string, unknown>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function codecName(c: string | null): string | null {
  if (!c) return null
  // "h264", or descriptive: "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10".
  const short = c.split(/ \/ | \(/)[0].trim().toLowerCase()
  return ({ h264: 'H.264', 'h.264': 'H.264', hevc: 'HEVC', 'h.265': 'HEVC', h265: 'HEVC', mpeg2video: 'MPEG-2', av1: 'AV1', vp9: 'VP9', aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', mp2: 'MP2', mp3: 'MP3', opus: 'Opus', dts: 'DTS' } as Record<string, string>)[short] ?? short.toUpperCase()
}

function channelsName(n: number | null): string | null {
  if (n == null) return null
  return n === 1 ? 'mono' : n === 2 ? 'stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : `${n} ch`
}

export function parseStreamInfo(raw: Raw | null): StreamInfo {
  raw = raw ?? {}
  const vp = (raw['video-params'] ?? {}) as Raw
  const ap = (raw['audio-params'] ?? {}) as Raw
  const w = num(vp.w)
  const h = num(vp.h)
  const fps = num(raw['estimated-vf-fps']) ?? num(raw['container-fps'])
  const video = w && h ? [`${w}×${h}`, codecName(str(raw['video-format']) ?? str(raw['video-codec'])), fps ? `${Math.round(fps)} fps` : null].filter(Boolean).join(' · ') : null
  const audio = [codecName(str(raw['audio-codec-name'])), channelsName(num(ap['channel-count']))].filter(Boolean).join(' ') || null
  const hw = str(raw['hwdec-current'])
  const vb = num(raw['video-bitrate'])
  const ab = num(raw['audio-bitrate'])
  const total = (vb ?? 0) + (ab ?? 0)
  const cache = num(raw['demuxer-cache-duration'])
  return {
    video,
    audio,
    decoding: hw && hw !== 'no' ? 'Hardware' : 'Software',
    bitrate: total > 0 ? `${(total / 1_000_000).toFixed(1)} Mbit/s` : null,
    buffer: cache != null ? `${cache.toFixed(0)} s` : null,
    audioDelay: num(raw['audio-delay']) ?? 0,
    subDelay: num(raw['sub-delay']) ?? 0,
    speed: num(raw['speed']) ?? 1,
  }
}

export async function streamInfo(): Promise<StreamInfo> {
  return parseStreamInfo(await ipc.mpvStreamInfo())
}

/** I key: the technical details over the picture. */
export async function showStreamInfo() {
  const i = await streamInfo().catch(() => null)
  if (!i?.video && !i?.audio) return osd('No stream info yet', 1500)
  osd(
    [
      i.video && `Video   ${i.video}`,
      i.audio && `Audio   ${i.audio}`,
      `Decoding   ${i.decoding}`,
      i.bitrate && `Bitrate   ${i.bitrate}`,
      i.buffer && `Buffer   ${i.buffer}`,
    ]
      .filter(Boolean)
      .join('\n'),
    6000,
  )
}
