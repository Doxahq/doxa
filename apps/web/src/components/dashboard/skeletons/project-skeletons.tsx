import { ChevronRight } from "lucide-react"

import {
  Bar,
  BadgeBar,
  FieldListSkeleton,
  PageBodySkeleton,
  PageHeadingSkeleton,
  TextBar,
} from "~/components/dashboard/skeletons/skeleton-kit"
import { FIELD_LABEL_CLASS } from "~/components/dashboard/dashboard-header"

/** The project Overview while the project loads: its heading, then the facts card. */
export function ProjectOverviewSkeleton() {
  return (
    <PageBodySkeleton label="Loading project">
      <PageHeadingSkeleton
        label="Project"
        titleWidth="10rem"
        description="Repository connection, publication state, and hosted documentation target."
      />
      <section className="flex flex-col gap-4">
        <FieldListSkeleton
          rows={[
            { label: "Status", width: "6.5rem", badge: true },
            { label: "Slug", width: "7rem", mono: true },
            { label: "Current branch", width: "3.5rem", mono: true },
            { label: "Repository", width: "11rem", mono: true },
            { label: "Docs target", width: "15rem", mono: true },
            { label: "Latest generation", width: "5.5rem", badge: true },
          ]}
        />
      </section>
    </PageBodySkeleton>
  )
}

/** The Generations list: its heading and the first rows of the list. */
export function ProjectGenerationsSkeleton() {
  return (
    <PageBodySkeleton label="Loading generations" className="max-w-4xl">
      <section className="flex flex-col gap-4">
        <PageHeadingSkeleton
          label="Project"
          title="Generations"
          description="Every documentation generation for this project, newest first."
          actions={<Bar width="8.5rem" height="2.25rem" className="rounded-md" />}
        />
        <GenerationRowsSkeleton />
      </section>
    </PageBodySkeleton>
  )
}

/** The rows of the Generations list, in the list's own card and row boxes. */
export function GenerationRowsSkeleton() {
  return (
    <ol className="surface-card">
      {["4.5rem", "4rem", "4.75rem", "4.25rem", "4.5rem"].map((idWidth, index) => (
        <li key={index} className={index > 0 ? "border-t border-divider" : undefined}>
          <div className="grid min-h-20 gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <BadgeBar width="5.5rem" />
                <TextBar width={idWidth} className="font-mono text-xs" />
              </div>
              <TextBar width="9rem" className="mt-2 text-xs" />
            </div>
            <TextBar width="3.25rem" className="font-mono text-xs" />
            <Bar width="1rem" height="1rem" />
          </div>
        </li>
      ))}
    </ol>
  )
}

/** One generation: the back link, the facts card and the log, before the generation loads. */
export function ProjectGenerationSkeleton() {
  return (
    <PageBodySkeleton label="Loading generation" className="max-w-7xl">
      {/* The back link's box: a small text row above the page. */}
      <TextBar width="6.5rem" className="text-sm" />
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <TextBar width="14rem" className="font-mono text-sm font-bold" />
            <p className="text-sm leading-6 text-muted-foreground">
              Deployment details, source identity, and generation output.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Bar width="4.5rem" height="2rem" className="rounded-md" />
            <Bar width="2rem" height="2rem" className="rounded-md" />
          </div>
        </div>
        <div className="surface-card p-5 sm:p-6">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Created", "8rem", ""],
              ["Status", "5.5rem", "badge"],
              ["Duration", "3.5rem", ""],
              ["Environment", "6rem", ""],
              ["Domains", "14rem", "wide"],
              ["Source", "12rem", "wide"],
            ].map(([label, width, kind]) => (
              <div key={label} className={kind === "wide" ? "flex min-w-0 flex-col gap-2 sm:col-span-2" : "flex min-w-0 flex-col gap-2"}>
                <dt className={FIELD_LABEL_CLASS}>{label}</dt>
                <dd className="min-w-0 text-[14.5px]">
                  {kind === "badge" ? <BadgeBar width={width} /> : <TextBar width={width} />}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
      {/* The log card, closed header and open body, as it first shows. */}
      <div className="surface-card">
        <div className="flex h-12 items-center gap-3 px-4">
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 rotate-90 text-muted-foreground" />
          <span className="font-mono text-xs font-bold tracking-[0.14em] text-foreground uppercase">Generation log</span>
        </div>
        <div className="flex h-[clamp(280px,46dvh,420px)] max-h-[420px] flex-col gap-3 overflow-hidden border-t border-divider bg-sidebar px-4 py-4">
          {["62%", "48%", "71%", "36%", "55%", "68%", "42%"].map((width, index) => (
            <Bar key={index} width={width} height="0.625rem" />
          ))}
        </div>
      </div>
    </PageBodySkeleton>
  )
}
