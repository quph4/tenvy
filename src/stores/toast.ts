import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error' | 'reminder' | 'support'

export interface ToastAction {
  label: string
  run(): void
}

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  /** Optional button, e.g. "Watch now" on a reminder. */
  action?: ToastAction
}

interface ToastOptions {
  action?: ToastAction
  /** ms before it disappears; toasts with an action stay longer. */
  duration?: number
}

interface ToastState {
  items: Toast[]
  push(kind: ToastKind, message: string, opts?: ToastOptions): void
  dismiss(id: number): void
}

let nextId = 1

export const useToast = create<ToastState>((set, get) => ({
  items: [],
  push(kind, message, opts) {
    const id = nextId++
    set({ items: [...get().items, { id, kind, message, action: opts?.action }] })
    const duration = opts?.duration ?? (opts?.action ? 60_000 : 4500)
    setTimeout(() => get().dismiss(id), duration)
  },
  dismiss(id) {
    set({ items: get().items.filter((t) => t.id !== id) })
  },
}))
