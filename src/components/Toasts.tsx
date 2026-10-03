import { AlertCircle, Bell, CheckCircle2, Info, X } from 'lucide-react'
import { useToast } from '../stores/toast'
import { cn } from '../lib/cn'

export function Toasts() {
  const items = useToast((s) => s.items)
  const dismiss = useToast((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg shadow-black/40 backdrop-blur animate-fade-in',
            t.kind === 'success' && 'border-emerald-500/30 bg-emerald-950/80 text-emerald-100',
            t.kind === 'error' && 'border-red-500/30 bg-red-950/80 text-red-100',
            t.kind === 'info' && 'border-neutral-700 bg-neutral-900/90 text-neutral-100',
            t.kind === 'reminder' && 'border-accent-500/40 bg-neutral-900/95 text-neutral-100',
          )}
        >
          <span className="mt-0.5 shrink-0">
            {t.kind === 'success' && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
            {t.kind === 'error' && <AlertCircle className="h-4 w-4 text-red-400" />}
            {t.kind === 'info' && <Info className="h-4 w-4 text-neutral-400" />}
            {t.kind === 'reminder' && <Bell className="h-4 w-4 text-accent-400" />}
          </span>
          <span className="line-clamp-3">{t.message}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
              className="ml-1 shrink-0 rounded-md bg-accent-400 px-2.5 py-1 text-xs font-semibold text-neutral-950 hover:bg-accent-300"
            >
              {t.action.label}
            </button>
          )}
          {t.action && (
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
