import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"

export function ExpandableCard({
  title,
  meta,
  open,
  onOpenChange,
  children,
}: {
  title: string
  meta?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <details
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className="group surface-card"
    >
      <summary className="flex h-12 cursor-pointer list-none items-center gap-3 px-4 marker:content-none hover:bg-surface-hover [&::-webkit-details-marker]:hidden focus-visible:-outline-offset-2">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90"
        />
        <span className="font-mono text-xs font-bold tracking-[0.14em] text-foreground uppercase">
          {title}
        </span>
        {meta ? (
          <div className="ml-auto flex items-center gap-3">{meta}</div>
        ) : null}
      </summary>
      <div className="border-t border-divider">{children}</div>
    </details>
  )
}
