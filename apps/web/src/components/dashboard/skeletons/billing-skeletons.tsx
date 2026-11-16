import type { ReactNode } from "react"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { AccountTopBar } from "~/components/dashboard/shell/top-bar"
import {
  Bar,
  BadgeBar,
  CardRowsSkeleton,
  PageBodySkeleton,
  PageHeadingSkeleton,
  TextBar,
} from "~/components/dashboard/skeletons/skeleton-kit"
import { BILLING_PAGE_TITLES, billingPageCrumbs, billingPageDescription, type BillingPage } from "~/lib/dashboard/billing-pages"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  )
}

/** The top bar and heading of an account's billing page. The Plan description names the account, so it is a bar. */
function BillingPageSkeleton({ page, label, children }: { page: BillingPage; label: string; children: ReactNode }) {
  return (
    <>
      <AccountTopBar crumbs={billingPageCrumbs(page)} />
      <PageBodySkeleton label={label}>
        <PageHeadingSkeleton
          label="Billing"
          title={BILLING_PAGE_TITLES[page]}
          description={
            page === "plan" ? (
              <TextBar width="24rem" className="text-sm leading-6" />
            ) : (
              billingPageDescription(page, { ownerKind: "user", name: null })
            )
          }
        />
        {children}
      </PageBodySkeleton>
    </>
  )
}

/** A card with one text row and a small button on the right: the payment method, the AI credits row. */
function CardLineSkeleton({ titleWidth, lineWidth }: { titleWidth: string; lineWidth: string }) {
  return (
    <div className="surface-card flex items-center gap-3.5 px-5 py-4">
      <Bar width="2.5rem" height="1.625rem" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TextBar width={titleWidth} className="text-[14.5px]" />
        <TextBar width={lineWidth} className="text-[13px]" />
      </div>
      <Bar width="7rem" height="2rem" />
    </div>
  )
}

/** Plan and invoices, shaped like the page: plan, payment method, AI credits, invoices. */
export function BillingAccountSkeleton() {
  return (
    <BillingPageSkeleton page="plan" label="Loading billing">
      <Section title="Plan">
        <div className="surface-card flex flex-col gap-1.5 px-5 py-5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <TextBar width="3rem" className="text-lg font-semibold" />
            <BadgeBar width="4.5rem" />
          </div>
          <TextBar width="16rem" className="text-sm" />
          <TextBar width="20rem" className="text-[13.5px]" />
        </div>
      </Section>
      <Section title="Payment method">
        <CardLineSkeleton titleWidth="8rem" lineWidth="18rem" />
      </Section>
      <CardLineSkeleton titleWidth="5rem" lineWidth="22rem" />
      <Section title="Invoices">
        <CardRowsSkeleton rows={["14rem", "12rem", "13rem"]} />
      </Section>
    </BillingPageSkeleton>
  )
}

/** AI credits, shaped like the page: this month, pay-as-you-go, cap per run, credit history. */
export function BillingCreditsSkeleton() {
  return (
    <BillingPageSkeleton page="credits" label="Loading AI credits">
      <Section title="This month">
        <div className="surface-card flex flex-col gap-4 px-5 py-5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <TextBar width="9rem" className="text-[14.5px]" />
            <TextBar width="7rem" className="text-[13px]" />
          </div>
          <Bar width="100%" height="0.375rem" />
          <div className="grid gap-4 sm:grid-cols-3">
            {["7rem", "8rem", "6rem"].map((width) => (
              <div key={width} className="flex flex-col gap-1">
                <TextBar width="8rem" className="text-[11px]" />
                <TextBar width={width} className="text-[14.5px]" />
              </div>
            ))}
          </div>
        </div>
      </Section>
      <Section title="Pay-as-you-go">
        <CardRowsSkeleton rows={["10rem", "12rem", "9rem", "11rem"]} />
      </Section>
      <Section title="Cap per run">
        <CardRowsSkeleton rows={["16rem", "15rem"]} rowHeight="6rem" />
      </Section>
      <Section title="Credit history">
        <CardRowsSkeleton rows={["10rem", "9rem", "11rem", "8rem"]} />
      </Section>
    </BillingPageSkeleton>
  )
}

/** `/dashboard/billing` with `?upgrade=`: the list of accounts. */
export function BillingAccountsSkeleton() {
  return (
    <>
      <AccountTopBar crumbs={["Billing"]} />
      <PageBodySkeleton label="Loading billing">
        <PageHeadingSkeleton label="Billing" title="Billing" description="Choose the account to upgrade or manage." />
        <CardRowsSkeleton rows={["10rem", "8rem"]} />
      </PageBodySkeleton>
    </>
  )
}
