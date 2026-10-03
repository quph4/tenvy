import { create } from 'zustand'
import type { Channel, ChannelKind, Group, Source } from '../types'
import { ipc } from '../lib/ipc'
import { useHistory } from './history'

interface PlaylistState {
  sources: Source[]
  activeSourceId: number | null

  /** Which class of content we're browsing. Favorites ignore this. */
  activeKind: ChannelKind

  groups: Group[]
  activeGroup: string | null // null = "All", "__favorites" = Favorites

  channels: Channel[]
  loadingChannels: boolean

  /** Series drilldown: the `Show.key` whose episodes are on screen. */
  openShowKey: string | null

  hydrate(): Promise<void>
  setActiveSource(id: number | null): Promise<void>
  setActiveKind(kind: ChannelKind): Promise<void>
  setActiveGroup(group: string | null): Promise<void>
  setOpenShowKey(key: string | null): void
  /** Navigate to a provider-structured series (e.g. from search). */
  openSeries(show: Channel): Promise<void>
  refreshChannels(): Promise<void>
}

export const FAVORITES_GROUP = '__favorites'
export const HISTORY_GROUP = '__history'

export const usePlaylist = create<PlaylistState>((set, get) => ({
  sources: [],
  activeSourceId: null,
  activeKind: 'live',
  groups: [],
  activeGroup: null,
  channels: [],
  loadingChannels: false,
  openShowKey: null,

  async hydrate() {
    const sources = await ipc.listSources()
    // Keep the current source if it still exists (e.g. after adding a
    // second playlist); otherwise fall back to the first one.
    const current = get().activeSourceId
    const activeSourceId = sources.some((s) => s.id === current) ? current : sources[0]?.id ?? null
    set({ sources, activeSourceId })
    const { activeKind } = get()
    const groups = await ipc.listGroups(activeSourceId, activeKind)
    set({ groups })
    await get().refreshChannels()
  },

  async setActiveSource(id) {
    set({ activeSourceId: id, activeGroup: null, openShowKey: null })
    const { activeKind } = get()
    const groups = await ipc.listGroups(id, activeKind)
    set({ groups })
    await get().refreshChannels()
  },

  async setActiveKind(kind) {
    if (get().activeKind === kind) return
    set({ activeKind: kind, activeGroup: null, openShowKey: null })
    const { activeSourceId } = get()
    const groups = await ipc.listGroups(activeSourceId, kind)
    set({ groups })
    await get().refreshChannels()
  },

  async setActiveGroup(group) {
    set({ activeGroup: group, openShowKey: null })
    await get().refreshChannels()
  },

  setOpenShowKey(key) {
    set({ openShowKey: key })
  },

  async openSeries(show) {
    if (get().activeKind !== 'series') await get().setActiveKind('series')
    if (get().activeGroup !== null) await get().setActiveGroup(null)
    set({ openShowKey: `c:${show.id}` })
  },

  async refreshChannels() {
    const { activeSourceId, activeGroup, activeKind } = get()
    set({ loadingChannels: true })
    try {
      let channels: Channel[]
      if (activeGroup === FAVORITES_GROUP) {
        channels = await ipc.listFavorites()
      } else if (activeGroup === HISTORY_GROUP) {
        // History needs both the joined list (for the row render) and a
        // fresh progress map (the other views read from it for badges).
        await Promise.all([
          useHistory.getState().loadEntries(),
          useHistory.getState().loadProgress(),
        ])
        channels = useHistory.getState().entries.map((e) => e.channel)
      } else {
        channels = await ipc.listChannels({
          sourceId: activeSourceId,
          group: activeGroup,
          kind: activeKind,
        })
      }
      set({ channels })
    } finally {
      set({ loadingChannels: false })
    }
  },
}))
