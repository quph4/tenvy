import { create } from 'zustand'

/** home: the start screen; player: live list + player or the library; epg: the guide. */
export type View = 'home' | 'player' | 'epg'

interface UIState {
  view: View
  searchOpen: boolean
  settingsOpen: boolean
  addSourceOpen: boolean
  manageCategoriesOpen: boolean

  setView(v: View): void
  openSearch(): void
  closeSearch(): void
  toggleSettings(): void
  openAddSource(): void
  closeAddSource(): void
  setManageCategories(open: boolean): void
}

export const useUI = create<UIState>((set) => ({
  view: 'home',
  searchOpen: false,
  settingsOpen: false,
  addSourceOpen: false,
  manageCategoriesOpen: false,

  setView: (v) => set({ view: v }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  openAddSource: () => set({ addSourceOpen: true, settingsOpen: false }),
  closeAddSource: () => set({ addSourceOpen: false }),
  setManageCategories: (open) => set({ manageCategoriesOpen: open, settingsOpen: false }),
}))
