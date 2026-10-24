import type { ReactNode } from "react"

import {
  Bar,
  BadgeBar,
  PageBodySkeleton,
  PageHeadingSkeleton,
  TextBar,
} from "~/components/dashboard/skeletons/skeleton-kit"

/** The Agent requests list: its heading, the filter row, and the first rows. */
export function ProjectRequestsSkeleton() {
  return (
    <PageBodySkeleton label="Loading requests" className="max-w-4xl">
      <PageHeadingSkeleton
        label="Requests"
        title="Agent requests"
        description="Actions that connected agents asked to run in this project. Pending requests wait for your decision."
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <FilterSkeleton label="Status" width="11rem" />
          <FilterSkeleton label="Agent" width="13rem" />
        </div>
        <RequestRowsSkeleton />
      </div>
    </PageBodySkeleton>
  )
}

/** The request rows, in the list's own border and row boxes. */
export function RequestRowsSkeleton() {
  return (
    <ul className="border border-border">
      {["62%", "48%", "56%", "40%"].map((width, index) => (
        <li key={index} className={index === 0 ? undefined : "border-t border-border"}>
          <div className="flex items-center gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <TextBar width={width} className="text-sm" />
              <TextBar width="9rem" className="text-xs" />
            </div>
            <BadgeBar width="4.5rem" />
            <span aria-hidden="true" className="size-4" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function FilterSkeleton({ label, width }: { label: string; width: string }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </span>
      {/* The select's box: 36px tall, with its border. */}
      <span className="rounded-md border border-input" style={{ width, height: "2.25rem" }} />
    </div>
  )
}

/** One request before it loads: heading, what happens, details and the decision card. */
export function ApprovalRequestSkeleton() {
  return (
    <PageBodySkeleton label="Loading request" className="max-w-3xl">
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <TextBar width="7rem" className="font-mono text-[11px]" />
            <TextBar width="16rem" className="text-[26px] leading-tight font-semibold" />
            <div className="flex flex-col gap-1">
              <TextBar width="100%" className="text-sm leading-6" />
              <TextBar width="60%" className="text-sm leading-6" />
            </div>
          </div>
          <BadgeBar width="4.5rem" />
        </header>
        <section className="flex flex-col gap-2">
          <h2 className="font-mono text-sm font-bold tracking-[0.12em] text-foreground uppercase">What happens</h2>
          <div className="flex flex-col gap-1 pl-5">
            <TextBar width="70%" className="text-sm" />
            <TextBar width="52%" className="text-sm" />
          </div>
        </section>
        <div className="surface-card flex flex-col gap-3 p-4">
          <Bar width="40%" height="0.8rem" />
          <div className="flex gap-2">
            <Bar width="6rem" height="2.25rem" className="rounded-md" />
            <Bar width="6rem" height="2.25rem" className="rounded-md" />
          </div>
        </div>
      </div>
    </PageBodySkeleton>
  )
}
