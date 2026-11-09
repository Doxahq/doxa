import type { CSSProperties, ReactNode } from "react"

import { FieldList, FieldRow, PageBody, PageTitle } from "~/components/dashboard/dashboard-header"
import { SKELETON_PULSE_STYLE, useSkeletonPulse } from "~/lib/dashboard/skeleton-pulse"
import { cn } from "~/lib/utils"

/**
 * Parts for page skeletons. One rule holds for every dashboard page: a visit
 * shows one loading state, shaped like the page, from the first frame until
 * the page. The route's pending view and the page's own loading state render
 * the same skeleton, so nothing swaps or blinks in between.
 *
 * Text that is known before any data (labels, headings, column names) is real
 * text. Bars stand only for data. Bar sizes are inline styles: a dev server
 * that missed a new utility class would draw a bar 0px tall.
 *
 * This module is light on purpose. Route pending views are not code split,
 * so it must not import a page module.
 */

/** The root of one skeleton: it announces the loading state and owns the shimmer clock. */
export function SkeletonRegion({
  label,
  className,
  children,
}: {
  /** Read by screen readers, for example "Loading project". */
  label: string
  className?: string
  children: ReactNode
}) {
  const ref = useSkeletonPulse<HTMLDivElement>()
  return (
    <div ref={ref} role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/** A whole page in the centered column, as `PageBody` draws it. */
export function PageBodySkeleton({
  label,
  className,
  children,
}: {
  label: string
  /** The page's own `PageBody` class, for example a wider column. */
  className?: string
  children: ReactNode
}) {
  return (
    <SkeletonRegion label={label} className="flex flex-1 flex-col">
      <PageBody className={className}>{children}</PageBody>
    </SkeletonRegion>
  )
}

/** One shimmering block. */
export function Bar({
  width,
  height,
  className,
  style,
}: {
  width: string
  height: string
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("block max-w-full shrink-0 rounded-sm bg-muted motion-safe:animate-pulse", className)}
      style={{ width, height, ...SKELETON_PULSE_STYLE, ...style }}
    />
  )
}

/**
 * A bar in place of one line of text. Give it the font classes of the real
 * text: the zero-width space gives it that text's line box, so the row keeps
 * the height it has with the real text.
 */
export function TextBar({ width, className }: { width: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("block", className)}>
      <Bar width={width} height="0.8em" className="inline-block align-middle" />
      {ZERO_WIDTH_SPACE}
    </span>
  )
}

const ZERO_WIDTH_SPACE = "\u200b"

/**
 * `PageHeading` with its known text, and a bar for a title that comes from
 * data, such as a project name. The classes are the heading's own.
 */
export function PageHeadingSkeleton({
  label,
  title,
  titleWidth = "11rem",
  titleTag,
  description,
  actions,
}: {
  label: string
  /** The real title, or omit it for a bar. */
  title?: string
  titleWidth?: string
  /** The same tag as the real page heading, for example `<BetaTag />`. */
  titleTag?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="font-mono text-[11px] font-medium tracking-[0.16em] text-label uppercase">{label}</span>
        {title ? (
          <PageTitle title={title} tag={titleTag} />
        ) : (
          <TextBar width={titleWidth} className="text-[26px] leading-tight font-semibold" />
        )}
        {description ? <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export interface FieldRowSkeleton {
  label: string
  /** The value bar width. */
  width: string
  /** Mono values (slugs, URLs) use the smaller mono size, as `FieldRow` does. */
  mono?: boolean
  /** A badge instead of text, for example a status. */
  badge?: boolean
}

/** A `FieldList` with its real labels and a bar for each value. */
export function FieldListSkeleton({ rows }: { rows: readonly FieldRowSkeleton[] }) {
  return (
    <FieldList>
      {rows.map((row) => (
        <FieldRow key={row.label} label={row.label} mono={row.mono}>
          {row.badge ? <BadgeBar width={row.width} /> : <TextBar width={row.width} />}
        </FieldRow>
      ))}
    </FieldList>
  )
}

/** A bar shaped like a `Badge`: 22px tall with rounded ends. */
export function BadgeBar({ width = "5rem" }: { width?: string }) {
  return (
    <span className="flex items-center" style={{ height: "1.375rem" }}>
      <Bar width={width} height="1.25rem" className="rounded-md" />
    </span>
  )
}

/** A `surface-card` with rows of bars, for lists whose rows hold one or two lines. */
export function CardRowsSkeleton({
  rows,
  rowHeight = "3.75rem",
  trailing = true,
}: {
  /** The width of each row's main line. Each row also gets a shorter second line. */
  rows: readonly string[]
  rowHeight?: string
  /** A small block on the right of each row, such as a status badge. */
  trailing?: boolean
}) {
  return (
    <div className="surface-card">
      {rows.map((width, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-t border-divider px-5 first:border-t-0"
          style={{ minHeight: rowHeight }}
        >
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: "0.5rem" }}>
            <Bar width={width} height="0.8rem" />
            <Bar width={`calc(${width} * 0.6)`} height="0.65rem" />
          </div>
          {trailing ? <Bar width="4.5rem" height="1.25rem" className="rounded-md" /> : null}
        </div>
      ))}
    </div>
  )
}
