import { create } from 'zustand'

export type View = 'player' | 'epg'

interface UIState {
  view: View
  searchOpen: boolean
  settingsOpen: boolean
  addSourceOpen: boolean

  setView(v: View): void
  openSearch(): void
  closeSearch(): void
  toggleSettings(): void
  openAddSource(): void
  closeAddSource(): void
}

export const useUI = create<UIState>((set) => ({
  view: 'player',
  searchOpen: false,
  settingsOpen: false,
  addSourceOpen: false,

  setView: (v) => set({ view: v }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  openAddSource: () => set({ addSourceOpen: true, settingsOpen: false }),
  closeAddSource: () => set({ addSourceOpen: false }),
}))
