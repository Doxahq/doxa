import { Link, useLocation } from "@tanstack/react-router"

import { DoxaMark } from "~/components/marketing/doxa-mark"

/** The centered column of the marketing site, with its 20px minimum gutter. */
const COLUMN = "mx-auto w-[min(1200px,calc(100%-40px))]"

/**
 * The default page for a request that matches nothing, on any surface. It can
 * show outside the marketing layout, so it takes the look of the marketing site
 * (guide lines, "+" joints, mono display type) from the global tokens only. The
 * layouts around it can already hold a `<main>`, so this page does not add one.
 * Inside the dashboard shell it fills the scroll area, not the whole window.
 */
export function NotFoundPage() {
  const { pathname } = useLocation()

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background font-sans text-foreground [[data-dashboard-shell]_&]:min-h-full [[data-dashboard-shell]_&]:flex-1">
      <div
        aria-hidden="true"
        className={`${COLUMN} pointer-events-none absolute inset-y-0 left-0 right-0 border-x border-dashed border-border`}
      />

      <header className={`${COLUMN} flex h-16 items-center justify-between px-5`}>
        <Link
          to="/"
          aria-label="Doxa home"
          className="flex items-center gap-2.5 font-mono text-sm font-bold tracking-[0.22em]"
        >
          <DoxaMark />
          DOXA
        </Link>
      </header>
      <GuideLine />

      <div className={`${COLUMN} flex flex-1 flex-col items-center justify-center px-5 py-16 text-center`}>
        <p
          aria-hidden="true"
          className="font-mono text-[clamp(7rem,24vw,15rem)] leading-[0.9] font-bold tracking-[-0.05em]"
        >
          404
        </p>
        <h1 className="mt-8 font-mono text-2xl font-bold tracking-[-0.03em] uppercase sm:text-3xl">
          Page <span className="bg-primary px-[0.1em] text-primary-foreground">not found</span>
        </h1>
        <p className="mt-4 max-w-md text-base text-muted-foreground">
          This page does not exist, or it moved to a new address.
        </p>
        <Link
          to="/"
          className="mt-9 inline-flex h-10 items-center bg-foreground px-4 font-mono text-xs font-medium tracking-[0.08em] whitespace-nowrap text-background uppercase transition-colors duration-75 hover:bg-foreground/85"
        >
          Back to home ›
        </Link>
      </div>

      <GuideLine />
      <footer
        className={`${COLUMN} flex h-14 items-center justify-between gap-6 px-5 font-mono text-[11px] tracking-[0.14em] text-label uppercase`}
      >
        <span className="min-w-0 truncate normal-case">GET {pathname}</span>
        <span className="shrink-0">404 Not found</span>
      </footer>
    </div>
  )
}

/** A dashed full-width line with a "+" where it meets each side of the column. */
function GuideLine() {
  const joint =
    "absolute top-0 -translate-x-1/2 -translate-y-1/2 bg-background px-0.5 font-mono text-[13px] leading-none text-label"
  return (
    <div aria-hidden="true" className="relative border-t border-dashed border-border">
      <span className={`${joint} left-[max(20px,calc((100%-1200px)/2))]`}>+</span>
      <span className={`${joint} left-[calc(100%-max(20px,calc((100%-1200px)/2)))]`}>+</span>
    </div>
  )
}
