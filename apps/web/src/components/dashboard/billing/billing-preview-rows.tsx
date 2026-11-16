import { Bar, SkeletonRegion } from "~/components/dashboard/skeletons/skeleton-kit"
import type { PreviewRow } from "~/lib/dashboard/billing-plan-change"
import { cn } from "~/lib/utils"

const ROW_CLASS = "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-divider px-4 py-3 first:border-t-0"

/** The amounts of a plan change, one row each, in a bordered list. Rows do nothing on click: no hover. */
export function BillingPreviewRows({ rows }: { rows: readonly PreviewRow[] }) {
  return (
    <dl className="surface-card">
      {rows.map((row) => (
        <div key={row.label} className={ROW_CLASS}>
          <dt className={cn("text-[13.5px]", row.strong ? "font-semibold text-foreground" : "text-muted-foreground")}>{row.label}</dt>
          <dd
            className={cn(
              "font-mono text-[13px]",
              row.tone === "success" ? "text-success" : "text-foreground",
              row.strong && "font-bold",
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The rows while the preview loads: the same box and row height, with bars. */
export function BillingPreviewRowsSkeleton({ count }: { count: number }) {
  return (
    <SkeletonRegion label="Loading the amounts" className="surface-card">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={ROW_CLASS}>
          <span className="text-[13.5px]">
            <Bar width={index === count - 1 ? "10rem" : "9rem"} height="0.8em" className="inline-block align-middle" />
            {"​"}
          </span>
          <Bar width="7rem" height="0.8rem" />
        </div>
      ))}
    </SkeletonRegion>
  )
}
