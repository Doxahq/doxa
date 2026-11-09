import { cn } from "~/lib/utils"

const NAV_ROW_WIDTHS = ["70%", "85%", "60%", "75%", "65%"]

/**
 * A small drawing of a docs site, so the card reads as "your site" at a
 * glance. It draws no page content, because the card does not load any.
 */
export function SitePreviewArt({ address, title }: { address: string | null; title: string | null }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-full min-h-56 flex-col overflow-hidden rounded-tl-md border-t border-l border-border bg-background"
    >
      <div className="flex h-7 shrink-0 items-center border-b border-divider px-3 font-mono text-[10.5px] text-label">
        <span className="truncate">{address}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-28 shrink-0 flex-col gap-3 border-r border-divider px-3 py-4">
          {NAV_ROW_WIDTHS.map((width, index) => (
            <span
              key={width}
              className={cn("h-1.5 rounded-sm", index === 0 ? "bg-muted-foreground" : "bg-border")}
              style={{ width }}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 px-4 py-4">
          <span className="truncate text-[17px] leading-6 font-semibold text-foreground">{title}</span>
          <span className="h-1.5 w-[92%] rounded-sm bg-border" />
          <span className="h-1.5 w-[78%] rounded-sm bg-border" />
          <span className="mt-1 h-16 rounded-sm border border-divider bg-card" />
          <span className="h-1.5 w-[84%] rounded-sm bg-divider" />
        </div>
      </div>
    </div>
  )
}
