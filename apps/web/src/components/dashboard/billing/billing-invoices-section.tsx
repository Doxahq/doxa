import type { BillingInvoice } from "@doxahq/contracts/billing"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { BillingStatusBadge } from "~/components/dashboard/billing/billing-status-badge"
import {
  BILLING_TABLE_HEAD_CLASS,
  BillingEmptyCard,
  BillingTableCard,
  BillingTableFooter,
} from "~/components/dashboard/billing/billing-table"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table"
import {
  formatBillingDate,
  formatCents,
  formatCredits,
  invoiceNeedsPayment,
  invoiceReasonLabel,
  invoiceStatusView,
} from "~/lib/dashboard/billing-model"
import { INVOICE_TAX_NOTE } from "~/lib/dashboard/billing-plan-view"
import { useRevealedRows, type MorePages } from "~/lib/dashboard/use-revealed-rows"

/** The invoice list shows 5 rows first, then 5 more for each "Show older invoices". */
export const INVOICE_ROWS_STEP = 5

const LINK_CLASS = "text-[13px] text-primary-text underline-offset-4 hover:underline"

/** INVOICES: a table with Pay and PDF links (spec 13: "Pay" opens the hosted invoice page), and the tax note. */
export function BillingInvoicesSection({
  invoices,
  pages,
  emptyText,
}: {
  invoices: readonly BillingInvoice[]
  pages: MorePages
  emptyText: string
}) {
  const rows = useRevealedRows(invoices, pages, INVOICE_ROWS_STEP)
  const hasPayment = invoices.some(invoiceNeedsPayment)

  return (
    <section className="flex flex-col gap-3" aria-labelledby="billing-invoices">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>
          <span id="billing-invoices">Invoices</span>
        </SectionLabel>
        {invoices.length > 0 ? <span className="text-[13px] text-label">{INVOICE_TAX_NOTE}</span> : null}
      </div>
      {invoices.length === 0 ? (
        <BillingEmptyCard>{emptyText}</BillingEmptyCard>
      ) : (
        <BillingTableCard
          label="Invoices"
          minWidth="38rem"
          footer={
            <BillingTableFooter
              summary={`Showing ${rows.visible.length} ${rows.visible.length === 1 ? "invoice" : "invoices"}`}
              hasMore={rows.hasMore}
              isLoadingMore={rows.isLoadingMore}
              moreLabel="Show older invoices"
              onShowMore={rows.showMore}
            />
          }
        >
          <TableHeader>
            <TableRow>
              <TableHead className={`${BILLING_TABLE_HEAD_CLASS} pl-5`}>Date</TableHead>
              <TableHead className={BILLING_TABLE_HEAD_CLASS}>Description</TableHead>
              <TableHead className={`${BILLING_TABLE_HEAD_CLASS} text-right`}>Amount</TableHead>
              <TableHead className={BILLING_TABLE_HEAD_CLASS}>Status</TableHead>
              <TableHead className={`${BILLING_TABLE_HEAD_CLASS} pr-5 text-right`}>{hasPayment ? "Action" : "PDF"}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.visible.map((invoice) => (
              <InvoiceRow key={invoice.invoiceId} invoice={invoice} />
            ))}
          </TableBody>
        </BillingTableCard>
      )}
    </section>
  )
}

function InvoiceRow({ invoice }: { invoice: BillingInvoice }) {
  const status = invoiceStatusView(invoice)
  const pay = invoiceNeedsPayment(invoice)
  const link = pay ? invoice.hostedInvoiceUrl : invoice.pdfUrl
  return (
    <TableRow>
      <TableCell className="py-3 pl-5 whitespace-nowrap text-muted-foreground">{formatBillingDate(invoice.createdAt)}</TableCell>
      <TableCell className="py-3 whitespace-nowrap text-foreground">
        {invoiceReasonLabel(invoice.reason)}
        {invoice.usageCredits > 0 ? ` · ${formatCredits(invoice.usageCredits)} credits` : null}
      </TableCell>
      <TableCell className="py-3 text-right font-mono whitespace-nowrap text-foreground">
        {formatCents(pay ? invoice.amountDueCents : invoice.amountPaidCents || invoice.amountDueCents)}
      </TableCell>
      <TableCell className="py-3">
        <BillingStatusBadge label={status.label} tone={status.tone} />
      </TableCell>
      <TableCell className="py-3 pr-5 text-right whitespace-nowrap">
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className={LINK_CLASS}>
            {pay ? "Pay this invoice" : "Download"}
          </a>
        ) : null}
      </TableCell>
    </TableRow>
  )
}
