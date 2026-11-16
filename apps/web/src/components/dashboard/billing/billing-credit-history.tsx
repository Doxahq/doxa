import { useState } from "react"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { SegmentedControl } from "~/components/dashboard/billing/billing-segmented-control"
import {
  BILLING_TABLE_HEAD_CLASS,
  BillingEmptyCard,
  BillingTableCard,
  BillingTableFooter,
} from "~/components/dashboard/billing/billing-table"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table"
import {
  CREDIT_HISTORY_FILTERS,
  creditHistoryActivity,
  creditHistoryAmount,
  filterCreditHistory,
  formatBillingDate,
  type CreditHistoryFilter,
  type CreditHistoryRow,
} from "~/lib/dashboard/billing-model"
import { useRevealedRows, type MorePages } from "~/lib/dashboard/use-revealed-rows"
import { cn } from "~/lib/utils"

/** The history shows 8 rows first, then 8 more for each "Show older activity". */
export const HISTORY_ROWS_STEP = 8

const EMPTY_TEXT: Record<CreditHistoryFilter, string> = {
  all: "No credit activity yet.",
  run: "No runs yet.",
  added: "No credits added or charged yet.",
}

/** CREDIT HISTORY: one row for each run, then grants and charges (spec 15.2), with a filter. */
export function BillingCreditHistory({ rows, pages }: { rows: readonly CreditHistoryRow[]; pages: MorePages }) {
  const [filter, setFilter] = useState<CreditHistoryFilter>("all")
  const filtered = filterCreditHistory(rows, filter)

  return (
    <section className="flex flex-col gap-3" aria-labelledby="billing-history">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>
          <span id="billing-history">Credit history</span>
        </SectionLabel>
        <SegmentedControl label="Show" value={filter} options={CREDIT_HISTORY_FILTERS} onChange={setFilter} />
      </div>
      {filtered.length === 0 && !pages.hasMore ? (
        <BillingEmptyCard>{EMPTY_TEXT[filter]}</BillingEmptyCard>
      ) : (
        // A new filter starts again from the first rows.
        <HistoryTable key={filter} rows={filtered} pages={pages} />
      )}
    </section>
  )
}

function HistoryTable({ rows, pages }: { rows: readonly CreditHistoryRow[]; pages: MorePages }) {
  const revealed = useRevealedRows(rows, pages, HISTORY_ROWS_STEP)
  return (
    <BillingTableCard
      label="Credit history"
      minWidth="32rem"
      footer={
        <BillingTableFooter
          summary={`Showing ${revealed.visible.length} ${revealed.visible.length === 1 ? "entry" : "entries"}`}
          hasMore={revealed.hasMore}
          isLoadingMore={revealed.isLoadingMore}
          moreLabel="Show older activity"
          onShowMore={revealed.showMore}
        />
      }
    >
      <TableHeader>
        <TableRow>
          <TableHead className={`${BILLING_TABLE_HEAD_CLASS} pl-5`}>Date</TableHead>
          <TableHead className={BILLING_TABLE_HEAD_CLASS}>Activity</TableHead>
          <TableHead className={`${BILLING_TABLE_HEAD_CLASS} pr-5 text-right`}>Credits</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {revealed.visible.map((row) => {
          const amount = creditHistoryAmount(row)
          return (
            <TableRow key={row.id}>
              <TableCell className="py-3 pl-5 whitespace-nowrap text-muted-foreground">{formatBillingDate(row.createdAt)}</TableCell>
              <TableCell className="py-3 whitespace-nowrap text-foreground">
                {creditHistoryActivity(row)}
                {row.subjectId ? <span className="font-mono text-xs text-muted-foreground"> · {row.subjectId.slice(0, 8)}</span> : null}
              </TableCell>
              <TableCell
                className={cn(
                  "py-3 pr-5 text-right font-mono whitespace-nowrap",
                  amount.tone === "success" && "text-success",
                  amount.tone === "default" && "text-foreground",
                  amount.tone === "muted" && "text-label",
                )}
              >
                {amount.text}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </BillingTableCard>
  )
}
