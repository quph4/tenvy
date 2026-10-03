import { useEffect, useState } from 'react'

/**
 * Tiny localStorage-backed useState. Not as fancy as zustand persist — it's
 * meant for throwaway UI preferences (sort order, pinned groups) that don't
 * belong in the main stores.
 */
export function usePref<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return initial
      return JSON.parse(raw) as T
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* quota / private mode — don't crash the UI over a pref */
    }
  }, [key, value])

  return [value, setValue]
}
