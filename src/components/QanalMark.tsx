/**
 * The Qanal "Q": a screen with a play button and the Q's tail. Same
 * geometry as src-tauri/icons/app-icon.svg (minus the background tile),
 * drawn in `currentColor` so it sits on any surface.
 */
export function QanalMark({ className }: { className?: string }) {
  return (
    <svg viewBox="200 230 640 580" className={className} aria-hidden="true">
      <rect x="220" y="250" width="584" height="464" rx="132" fill="none" stroke="currentColor" strokeWidth="88" />
      <path
        d="M452 386 L452 578 L612 482 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="28"
        strokeLinejoin="round"
      />
      <path d="M668 626 L812 786" stroke="currentColor" strokeWidth="92" strokeLinecap="round" />
    </svg>
  )
}
