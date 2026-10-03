import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastState {
  items: Toast[]
  push(kind: ToastKind, message: string): void
  dismiss(id: number): void
}

let nextId = 1

export const useToast = create<ToastState>((set, get) => ({
  items: [],
  push(kind, message) {
    const id = nextId++
    set({ items: [...get().items, { id, kind, message }] })
    setTimeout(() => get().dismiss(id), 4500)
  },
  dismiss(id) {
    set({ items: get().items.filter((t) => t.id !== id) })
  },
}))
