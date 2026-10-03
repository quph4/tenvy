import { CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { useToast } from '../stores/toast'
import { cn } from '../lib/cn'

export function Toasts() {
  const items = useToast((s) => s.items)
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg shadow-black/40 backdrop-blur animate-fade-in',
            t.kind === 'success' && 'border-emerald-500/30 bg-emerald-950/80 text-emerald-100',
            t.kind === 'error' && 'border-red-500/30 bg-red-950/80 text-red-100',
            t.kind === 'info' && 'border-neutral-700 bg-neutral-900/90 text-neutral-100',
          )}
        >
          {t.kind === 'success' && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
          {t.kind === 'error' && <AlertCircle className="h-4 w-4 text-red-400" />}
          {t.kind === 'info' && <Info className="h-4 w-4 text-neutral-400" />}
          <span className="max-w-xs truncate">{t.message}</span>
        </div>
      ))}
    </div>
  )
}
