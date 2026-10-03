import { useState } from 'react'
import { cn } from '../../lib/cn'

/**
 * Poster art with a designed fallback for missing or broken images: a
 * tinted tile with the title, so a grid with gaps still looks intentional.
 */
export function Poster({ src, title, className }: { src: string | null; title: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        // Poster CDNs (TMDB mirrors, panel image hosts) often refuse
        // hotlinks that carry a Referer from an unknown origin.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn('h-full w-full object-cover', className)}
      />
    )
  }
  return (
    <div
      className="flex h-full w-full items-end bg-gradient-to-br p-3"
      style={{ backgroundImage: `linear-gradient(135deg, hsl(${hue(title)} 45% 22%), hsl(${hue(title) + 40} 35% 10%))` }}
    >
      <span className="line-clamp-4 text-sm font-semibold leading-snug text-white/85">{title}</span>
    </div>
  )
}

/** Stable per-title hue so fallbacks differ but don't flicker. */
function hue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}
