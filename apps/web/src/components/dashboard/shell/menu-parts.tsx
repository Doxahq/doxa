import type { ReactNode } from "react"

import { cn } from "~/lib/utils"

/** Uppercase mono label above a group of menu rows. */
export function MenuSectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-label uppercase">
      {children}
    </span>
  )
}

/** The keyboard hint row at the bottom of a switcher dropdown. */
export function KeyHints({ hints }: { hints: readonly string[] }) {
  return (
    <div className="flex gap-3 border-t border-divider px-3 py-1.5 font-mono text-[10.5px] text-label">
      {hints.map((hint) => (
        <span key={hint}>{hint}</span>
      ))}
    </div>
  )
}

/** LIVE (green) or DRAFT (amber) tag: color text, 8% fill, 35% border. */
export function BranchTag({
  tone,
  children,
  className,
}: {
  tone: "live" | "draft"
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border px-1.5 py-px font-mono text-[9.5px] font-semibold tracking-[0.12em] uppercase",
        tone === "live"
          ? "border-success/35 bg-success/8 text-success"
          : "border-warning/35 bg-warning/8 text-warning",
        className,
      )}
    >
      {children}
    </span>
  )
}
