import { create } from 'zustand'
import type { Channel, ChannelKind, Group, Source } from '../types'
import { ipc } from '../lib/ipc'
import { useHistory } from './history'
import { useUI } from './ui'
import { showFromContainer, type LibraryItem } from '../lib/series'

interface PlaylistState {
  sources: Source[]
  activeSourceId: number | null

  /** Which class of content we're browsing. Favorites ignore this. */
  activeKind: ChannelKind

  groups: Group[]
  activeGroup: string | null // null = "All", "__favorites" = Favorites

  channels: Channel[]
  loadingChannels: boolean

  /** Library details page: the movie or show on screen, if any. */
  selected: LibraryItem | null

  hydrate(): Promise<void>
  setActiveSource(id: number | null): Promise<void>
  setActiveKind(kind: ChannelKind): Promise<void>
  setActiveGroup(group: string | null): Promise<void>
  select(item: LibraryItem | null): void
  /** Open a movie or series details page from anywhere (e.g. search). */
  openDetails(ch: Channel): Promise<void>
  refreshChannels(): Promise<void>
}

export const FAVORITES_GROUP = '__favorites'
export const HISTORY_GROUP = '__history'

// Lists load asynchronously, and the viewer (or playback) can switch tab,
// category or provider before an answer arrives. Every load takes a
// ticket; only the newest ticket's answer is applied, so a slow reply for
// the previous tab can never overwrite the current one.
let groupsTicket = 0
let channelsTicket = 0

export const usePlaylist = create<PlaylistState>((set, get) => ({
  sources: [],
  activeSourceId: null,
  activeKind: 'live',
  groups: [],
  activeGroup: null,
  channels: [],
  loadingChannels: false,
  selected: null,

  async hydrate() {
    const sources = await ipc.listSources()
    // Keep the current source if it still exists (e.g. after adding a
    // second playlist); otherwise fall back to the first one.
    const current = get().activeSourceId
    const activeSourceId = sources.some((s) => s.id === current) ? current : sources[0]?.id ?? null
    set({ sources, activeSourceId })
    await Promise.all([loadGroups(), get().refreshChannels()])
  },

  async setActiveSource(id) {
    set({ activeSourceId: id, activeGroup: null, selected: null })
    await Promise.all([loadGroups(), get().refreshChannels()])
  },

  async setActiveKind(kind) {
    if (get().activeKind === kind) return
    // Clear the old tab's lists at once rather than showing them under the
    // new tab until the new ones arrive.
    set({ activeKind: kind, activeGroup: null, selected: null, groups: [], channels: [] })
    // The guide is for live TV; films and series open in the library.
    if (kind !== 'live' && useUI.getState().view === 'epg') useUI.getState().setView('player')
    await Promise.all([loadGroups(), get().refreshChannels()])
  },

  async setActiveGroup(group) {
    set({ activeGroup: group, selected: null })
    await get().refreshChannels()
  },

  select(item) {
    set({ selected: item })
  },

  async openDetails(ch) {
    const kind = ch.kind === 'live' ? 'live' : ch.kind
    if (get().activeKind !== kind) await get().setActiveKind(kind)
    set({
      selected: ch.container
        ? { type: 'show', show: showFromContainer(ch) }
        : { type: 'movie', channel: ch },
    })
  },

  async refreshChannels() {
    const { activeSourceId, activeGroup, activeKind } = get()
    const ticket = ++channelsTicket
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
      if (ticket === channelsTicket) set({ channels })
    } finally {
      if (ticket === channelsTicket) set({ loadingChannels: false })
    }
  },
}))

/** Categories for the current provider and tab (newest request wins). */
async function loadGroups() {
  const { activeSourceId, activeKind } = usePlaylist.getState()
  const ticket = ++groupsTicket
  const groups = await ipc.listGroups(activeSourceId, activeKind)
  if (ticket === groupsTicket) usePlaylist.setState({ groups })
}
