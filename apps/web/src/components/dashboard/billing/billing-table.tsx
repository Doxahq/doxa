import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "~/components/ui/button"
import { Table } from "~/components/ui/table"

/** Uppercase mono column header, as every dashboard table has. */
export const BILLING_TABLE_HEAD_CLASS = "h-10 font-mono text-[10px] font-normal tracking-[0.16em] text-label uppercase"

/**
 * A billing table in its card. The table scrolls sideways inside the card on
 * a narrow screen, so the page never does. The footer holds the count and
 * "Show older …".
 */
export function BillingTableCard({ label, minWidth, children, footer }: { label: string; minWidth: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="surface-card overflow-hidden">
      <Table aria-label={label} className="text-[13.5px]" style={{ minWidth }}>
        {children}
      </Table>
      {footer}
    </div>
  )
}

export function BillingTableFooter({
  summary,
  hasMore,
  isLoadingMore,
  moreLabel,
  onShowMore,
}: {
  summary: string
  hasMore: boolean
  isLoadingMore: boolean
  moreLabel: string
  onShowMore: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-divider px-5 py-2.5">
      <span className="text-[12.5px] text-label">{summary}</span>
      {hasMore ? (
        <Button variant="ghost" size="sm" disabled={isLoadingMore} onClick={onShowMore}>
          {isLoadingMore ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {moreLabel}
        </Button>
      ) : null}
    </div>
  )
}

/** The empty card of a list: one centered muted line. */
export function BillingEmptyCard({ children }: { children: ReactNode }) {
  return <p className="surface-card px-5 py-6 text-center text-sm text-muted-foreground">{children}</p>
}
