import { cn } from "~/lib/utils"

/** A small accent "Beta" tag for a feature that is still in beta, for example Doxabot. */
export function BetaTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border border-primary/35 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-[0.12em] text-primary uppercase",
        className,
      )}
    >
      Beta
    </span>
  )
}
