import type { ReactNode } from "react"

/** A line icon on a square box, in `currentColor`. */
function Line({ size, width = 1.4, children }: { size: number; width?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const GITHUB_PATH =
  "M8 0a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 0z"

export function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d={GITHUB_PATH} />
    </svg>
  )
}

/** The Doxa mark with its eye cut out, so the background shows through. */
const MARK_WITH_EYE =
  "M59.6064 0.594138C33.4643 0.594138 12.0754 14.8535 4.9457 38.619C-4.56052 71.8908 0.192588 121.798 14.4519 155.07C28.7112 185.965 57.2299 197.848 85.7485 190.718C119.02 181.212 147.539 150.317 157.045 114.669C166.551 74.2673 152.292 33.8659 126.15 14.8535C109.514 2.97069 83.372 -1.78242 59.6064 0.594138Z" +
  "M73.8658 109.321C83.3816 109.321 91.0958 101.607 91.0958 92.0913C91.0958 82.5755 83.3816 74.8613 73.8658 74.8613C64.3499 74.8613 56.6357 82.5755 56.6357 92.0913C56.6357 101.607 64.3499 109.321 73.8658 109.321Z"

/**
 * Doxabot, as the dashboard sidebar draws it (`DoxabotIcon`): the Doxa mark as
 * a bot, with an antenna whose tip takes the accent color.
 */
export function DoxabotMark({ width, height, className }: { width: number; height: number; className?: string }) {
  return (
    <svg className={className} width={width} height={height} viewBox="-4 -4 172 251" aria-hidden="true">
      <path d="M88 56 L100 18" stroke="currentColor" strokeWidth={12} strokeLinecap="round" />
      <circle cx={102} cy={13} r={13} fill="#6aa6ff" />
      <path d={MARK_WITH_EYE} transform="translate(0 50)" fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}

export const EyeIcon = ({ size = 14 }: { size?: 14 | 18 }) =>
  size === 14 ? (
    <Line size={14}>
      <path d="M1.5 7S3.5 3 7 3s5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4z" />
      <circle cx="7" cy="7" r="1.6" />
    </Line>
  ) : (
    <Line size={18}>
      <path d="M1.5 9S4 4 9 4s7.5 5 7.5 5-2.5 5-7.5 5-7.5-5-7.5-5z" />
      <circle cx="9" cy="9" r="2" />
    </Line>
  )

export const BranchIcon = ({ size = 14 }: { size?: 14 | 18 }) =>
  size === 14 ? (
    <Line size={14}>
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="4" cy="11" r="1.5" />
      <circle cx="10.5" cy="5.5" r="1.5" />
      <path d="M4 4.5v5M10.5 7c0 2-2.5 2-5 3" />
    </Line>
  ) : (
    <Line size={18}>
      <circle cx="5" cy="4" r="1.8" />
      <circle cx="5" cy="14" r="1.8" />
      <circle cx="13" cy="7" r="1.8" />
      <path d="M5 5.8v6.4M13 8.8c0 2.5-3 2.5-6.5 4" />
    </Line>
  )

export const ShieldIcon = ({ size = 14 }: { size?: 14 | 18 }) =>
  size === 14 ? (
    <Line size={14}>
      <path d="M7 1.5 12 3.5v3.5c0 3-2.2 4.9-5 5.5-2.8-.6-5-2.5-5-5.5V3.5z" />
      <path d="m4.8 7 1.6 1.6 2.8-3" />
    </Line>
  ) : (
    <Line size={18}>
      <path d="M9 2 15 4.5v4c0 3.6-2.6 6-6 6.8-3.4-.8-6-3.2-6-6.8v-4z" />
      <path d="m6.2 9 2 2 3.6-4" />
    </Line>
  )

export const NoTrainIcon = () => (
  <Line size={18}>
    <rect x="3" y="3" width="12" height="12" />
    <path d="M6 6l6 6M12 6l-6 6" />
  </Line>
)

/** 16px icons for the feature lists. */
export const LIST_ICONS = {
  check: <path d="M2.5 8.5 6 12l7.5-8" />,
  refresh: (
    <>
      <path d="M13 3.5A6 6 0 1 0 14 8" />
      <path d="M13.5 1v3h-3" />
    </>
  ),
  list: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M5 6h6M5 8.5h6M5 11h3.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  source: (
    <>
      <path d="M5.5 2.5h-3v11h11v-3" />
      <path d="M8.5 2.5h5v5M13.5 2.5 7 9" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" />
      <path d="M2 6h12" />
    </>
  ),
  file: (
    <>
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M9.5 2.5V5H12" />
    </>
  ),
  minus: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5 8h6" />
    </>
  ),
  pullRequest: (
    <>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v6M12 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />
    </>
  ),
} as const

export type ListIconName = keyof typeof LIST_ICONS

export function ListIcon({ name }: { name: ListIconName }) {
  return <Line size={16}>{LIST_ICONS[name]}</Line>
}

/** 18px icons for the "What it writes" cards. */
export const WRITE_ICONS = {
  book: (
    <>
      <path d="M3 3.5h5.5a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 0-1.5-1.5H3z" />
      <path d="M15 3.5H9.5A1.5 1.5 0 0 0 8 5" />
      <path d="M15 3.5v9.5H9.5" />
    </>
  ),
  brackets: <path d="M6 5 2.5 9 6 13M12 5l3.5 4-3.5 4" />,
  search: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="m12 12 3.5 3.5" />
    </>
  ),
  table: (
    <>
      <rect x="2.5" y="3" width="13" height="12" />
      <path d="M2.5 6.5h13M6 6.5V15" />
    </>
  ),
  lines: <path d="M3 4.5h12M3 9h8M3 13.5h10" />,
  play: <path d="M5 4l9 5-9 5z" />,
  code: <path d="M4.5 6.5 2 9l2.5 2.5M13.5 6.5 16 9l-2.5 2.5M10.5 4l-3 10" />,
} as const

export type WriteIconName = keyof typeof WRITE_ICONS

export function WriteIcon({ name }: { name: WriteIconName }) {
  return <Line size={18}>{WRITE_ICONS[name]}</Line>
}

/** The 10px check mark inside a green square. */
export function TickIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m2 5.2 2 2 4-4.4" />
    </svg>
  )
}

export function GlobeIcon() {
  return (
    <Line size={14} width={1.3}>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M1.5 7h11M7 1.5c1.8 2 1.8 9 0 11M7 1.5c-1.8 2-1.8 9 0 11" />
    </Line>
  )
}
