import { ArrowDown, ArrowUp, EyeOff, Star, StarOff } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { ipc } from '../lib/ipc'
import { FAVORITES_GROUP, usePlaylist } from '../stores/playlist'
import { useToast } from '../stores/toast'
import type { Channel } from '../types'

/** The channel menu on screen (right-click or ⋯ on a row). */
export const useChannelMenu = create<{
  open: { channel: Channel; x: number; y: number } | null
  show(channel: Channel, x: number, y: number): void
  close(): void
}>((set) => ({
  open: null,
  show: (channel, x, y) => set({ open: { channel, x, y } }),
  close: () => set({ open: null }),
}))

/** Actions on one channel: favorite, its place in Favorites, hide. */
export function ChannelMenu() {
  const open = useChannelMenu((s) => s.open)
  const close = useChannelMenu((s) => s.close)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  if (!open) return null
  const { channel } = open
  const pl = usePlaylist.getState()
  const inFavorites = pl.activeGroup === FAVORITES_GROUP
  const index = inFavorites ? pl.channels.findIndex((c) => c.id === channel.id) : -1
  const push = useToast.getState().push

  const run = (fn: () => Promise<unknown>) => () => {
    close()
    fn().catch((e) => push('error', String(e).replace(/^Error:\s*/, '')))
  }

  const move = (delta: number) =>
    run(async () => {
      const ids = pl.channels.map((c) => c.id)
      const [id] = ids.splice(index, 1)
      ids.splice(index + delta, 0, id)
      await ipc.reorderFavorites(ids)
      await usePlaylist.getState().refreshChannels()
    })

  const items = [
    {
      icon: inFavorites ? StarOff : Star,
      label: inFavorites ? 'Remove from favorites' : 'Add to favorites',
      action: run(async () => {
        const fav = await ipc.toggleFavorite(channel.id)
        push('success', fav ? `★ Added ${channel.name}` : `Removed ${channel.name}`)
        if (inFavorites) await usePlaylist.getState().refreshChannels()
      }),
    },
    ...(inFavorites && index > 0 ? [{ icon: ArrowUp, label: 'Move up', action: move(-1) }] : []),
    ...(inFavorites && index >= 0 && index < pl.channels.length - 1 ? [{ icon: ArrowDown, label: 'Move down', action: move(1) }] : []),
    {
      icon: EyeOff,
      label: 'Hide channel',
      action: run(async () => {
        await ipc.setChannelHidden(channel.id, true)
        push('info', `Hid ${channel.name}. Bring it back under Manage categories → Hidden channels.`)
        await usePlaylist.getState().refreshChannels()
      }),
    },
  ]

  // Keep the menu inside the window.
  const x = Math.min(open.x, window.innerWidth - 220)
  const y = Math.min(open.y, window.innerHeight - items.length * 36 - 16)

  return (
    <div
      ref={ref}
      style={{ left: x, top: y }}
      className="fixed z-[70] w-52 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/95 py-1 shadow-2xl shadow-black/60 backdrop-blur animate-fade-in"
    >
      <div className="truncate px-3 py-1.5 text-[11px] font-semibold text-neutral-500">{channel.name}</div>
      {items.map(({ icon: Icon, label, action }) => (
        <button
          key={label}
          onClick={action}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
        >
          <Icon className="h-3.5 w-3.5 text-neutral-400" />
          {label}
        </button>
      ))}
    </div>
  )
}
