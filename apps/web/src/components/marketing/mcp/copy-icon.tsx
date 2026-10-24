/** The two-squares copy glyph of the design's copy buttons. */
export function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="4.5" y="4.5" width="8" height="8" />
      <path d="M9.5 4.5v-3h-8v8h3" />
    </svg>
  )
}

/** The circled "i" before notes. */
export function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 6.2v3.6M7 4.2v.1" />
    </svg>
  )
}

/** The small check mark of the picker dot and the consent boxes. */
export function CheckIcon({ hidden = true }: { hidden?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden={hidden ? "true" : undefined}
    >
      <path d="m2 5.2 2 2 4-4.4" />
    </svg>
  )
}
