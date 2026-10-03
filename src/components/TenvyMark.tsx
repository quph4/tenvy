/**
 * The Tenvy mark: a screen on a stand with a bold T inside. Same geometry
 * as src-tauri/icons/app-icon.svg (minus the background tile), drawn in
 * `currentColor` so it sits on any surface.
 */
export function TenvyMark({ className }: { className?: string }) {
  return (
    <svg viewBox="150 170 724 690" className={className} aria-hidden="true">
      <rect x="196" y="212" width="632" height="500" rx="128" fill="none" stroke="currentColor" strokeWidth="80" />
      <path d="M372 372 H652 M512 372 V572" stroke="currentColor" strokeWidth="88" strokeLinecap="round" />
      <path d="M392 812 H632" stroke="currentColor" strokeWidth="64" strokeLinecap="round" />
    </svg>
  )
}
