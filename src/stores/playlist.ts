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

  hydrate(): Promise<void>
  setActiveSource(id: number | null): Promise<void>
  setActiveKind(kind: ChannelKind): Promise<void>
  setActiveGroup(group: string | null): Promise<void>
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

  async hydrate() {
    const sources = await ipc.listSources()
    const activeSourceId = sources[0]?.id ?? null
    set({ sources, activeSourceId })
    const { activeKind } = get()
    const groups = await ipc.listGroups(activeSourceId, activeKind)
    set({ groups })
    await get().refreshChannels()
  },

  async setActiveSource(id) {
    set({ activeSourceId: id, activeGroup: null })
    const { activeKind } = get()
    const groups = await ipc.listGroups(id, activeKind)
    set({ groups })
    await get().refreshChannels()
  },

  async setActiveKind(kind) {
    if (get().activeKind === kind) return
    set({ activeKind: kind, activeGroup: null })
    const { activeSourceId } = get()
    const groups = await ipc.listGroups(activeSourceId, kind)
    set({ groups })
    await get().refreshChannels()
  },

  async setActiveGroup(group) {
    set({ activeGroup: group })
    await get().refreshChannels()
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
        // Refresh in parallel so opening History doesn't visibly lag.
        await useHistory.getState().loadEntries()
        await useHistory.getState().loadProgress()
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
