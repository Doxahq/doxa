import type { CSSProperties, ReactNode } from "react"

import { useShell } from "~/lib/dashboard/shell-context"
import { SKELETON_PULSE_STYLE, useSkeletonPulse } from "~/lib/dashboard/skeleton-pulse"
import { cn } from "~/lib/utils"

/**
 * The content editor while a page loads: the properties strip, then a page in
 * the Write editor's column (title, description, text, a heading, a code
 * block, a list) and the "On this page" outline. Its boxes follow the editor's
 * layout, so the page settles in place when it arrives.
 *
 * Sizes are inline, not utility classes. A dev server that missed a new
 * utility class would draw a bar 0px tall (see `content-row-indent.ts`).
 */
export function EditorSkeleton({ showOutline = true }: { showOutline?: boolean }) {
  const ref = useSkeletonPulse<HTMLDivElement>()
  return (
    <div ref={ref} role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col bg-editor">
      <span className="sr-only">Loading page</span>
      <PropertiesStripSkeleton />
      <div aria-hidden="true" className="@container relative min-h-0 flex-1 overflow-hidden">
        <div className="flex justify-center gap-14 px-12 pt-14 pb-40 @max-[640px]:px-6 @max-[640px]:pt-9 @max-[420px]:px-5">
          <div className="w-full max-w-3xl min-w-0">
            <ArticleSkeleton />
          </div>
          {showOutline ? <OutlineSkeleton /> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The content route's view while its code loads. It is the same skeleton the
 * page shows while its data loads, in the same box (under the top bar, with
 * the editor's top border), so a visit to the editor shows one loading state
 * from the click until the page, never a spinner first.
 */
export function ContentPagePending() {
  const { focusMode } = useShell()
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <EditorSkeleton showOutline={!focusMode} />
    </div>
  )
}

/** A page body, without the editor chrome. The Split preview uses it too. */
export function ArticleSkeleton() {
  return (
    <div>
      {/* Title and description, at the sizes of the editor's fields. */}
      <Line height="2.25rem" width="52%" />
      <Line height="1.125rem" width="78%" style={{ marginTop: "1.125rem" }} />
      <Line height="1.125rem" width="46%" style={{ marginTop: "0.625rem" }} />

      <div style={{ marginTop: "2.75rem" }}>
        <Paragraph widths={["100%", "96%", "88%", "64%"]} />
        <Line height="1.5rem" width="34%" style={{ marginTop: "2.5rem" }} />
        <Paragraph widths={["98%", "92%", "42%"]} style={{ marginTop: "1.25rem" }} />
        <CodeBlockSkeleton />
        <Paragraph widths={["94%", "72%"]} style={{ marginTop: "1.75rem" }} />
        <ListSkeleton widths={["58%", "66%", "48%"]} />
      </div>
    </div>
  )
}

/** The MDX source pane of Split mode: line numbers and lines of code. */
export function SourceSkeleton() {
  const ref = useSkeletonPulse<HTMLDivElement>()
  const widths = ["8%", "34%", "52%", "8%", "", "46%", "", "88%", "76%", "62%", "", "30%", "", "40%", "70%", "22%", "", "84%", "58%"]
  return (
    <div ref={ref} role="status" aria-busy="true" className="min-h-0 flex-1 overflow-hidden bg-card" style={{ paddingTop: "0.75rem" }}>
      <span className="sr-only">Loading source</span>
      <div aria-hidden="true">
        {widths.map((width, index) => (
          <div key={index} className="flex items-center" style={{ height: "1.375rem" }}>
            <span className="shrink-0 pr-3 text-right font-mono text-[11px] text-faint" style={{ width: "2.75rem" }}>
              {index + 1}
            </span>
            {width ? <Bar width={width} height="0.625rem" /> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The rendered page in the Split preview. */
export function PreviewSkeleton() {
  const ref = useSkeletonPulse<HTMLDivElement>()
  return (
    <div ref={ref} role="status" aria-busy="true" className="min-h-0 flex-1 overflow-hidden" style={{ padding: "2.5rem 2rem" }}>
      <span className="sr-only">Loading preview</span>
      <div aria-hidden="true" className="mx-auto w-full max-w-3xl">
        <ArticleSkeleton />
      </div>
    </div>
  )
}

/** The editor's strip above the page: SLUG on the left, the site theme on the right. */
function PropertiesStripSkeleton() {
  return (
    <div aria-hidden="true" className="flex shrink-0 items-center justify-between gap-x-4 border-b border-border bg-editor px-4">
      <div className="flex items-center gap-2.5 py-2.5 pr-4">
        <span className="font-mono text-[10px] font-medium tracking-[0.16em] text-label uppercase">Slug</span>
        {/* The slug field's line box (24px), with a bar for the URL. */}
        <span className="flex items-center" style={{ height: "1.5rem" }}>
          <Bar width="8.5rem" height="0.75rem" />
        </span>
      </div>
      <div className="flex items-center gap-2.5 py-1.5">
        <span className="font-mono text-[10px] font-medium tracking-[0.16em] text-label uppercase">Site theme</span>
        <span className="rounded-md border border-border" style={{ width: "6.5rem", height: "1.75rem" }} />
      </div>
    </div>
  )
}

function OutlineSkeleton() {
  return (
    // The outline's box: 200px wide, pushed below the title, hidden on narrow windows.
    <div className="w-[200px] shrink-0 self-start pt-[180px] max-[1240px]:hidden">
      <Line height="0.875rem" width="58%" />
      <div className="border-l border-border/50" style={{ marginTop: "0.875rem", paddingLeft: "0.875rem" }}>
        {["82%", "64%", "74%", "52%", "68%"].map((width, index) => (
          <Line key={index} height="0.625rem" width={width} style={{ marginTop: index === 0 ? "0.375rem" : "0.875rem" }} />
        ))}
      </div>
    </div>
  )
}

function Paragraph({ widths, style }: { widths: string[]; style?: CSSProperties }) {
  return (
    <div style={style}>
      {widths.map((width, index) => (
        <Line key={index} height="0.875rem" width={width} style={{ marginTop: index === 0 ? 0 : "0.75rem" }} />
      ))}
    </div>
  )
}

function CodeBlockSkeleton() {
  return (
    <div className="rounded-lg border border-border/60" style={{ marginTop: "1.75rem", padding: "1rem 1.125rem" }}>
      {["44%", "70%", "58%", "36%"].map((width, index) => (
        <Line key={index} height="0.75rem" width={width} style={{ marginTop: index === 0 ? 0 : "0.75rem" }} />
      ))}
    </div>
  )
}

function ListSkeleton({ widths }: { widths: string[] }) {
  return (
    <div style={{ marginTop: "1.5rem" }}>
      {widths.map((width, index) => (
        <div key={index} className="flex items-center gap-3" style={{ marginTop: index === 0 ? 0 : "0.875rem" }}>
          <Bar width="0.375rem" height="0.375rem" className="rounded-full" />
          <Bar width={width} height="0.875rem" />
        </div>
      ))}
    </div>
  )
}

function Line({ width, height, style }: { width: string; height: string; style?: CSSProperties }) {
  return (
    <div style={style}>
      <Bar width={width} height={height} />
    </div>
  )
}

function Bar({
  width,
  height,
  className,
}: {
  width: string
  height: string
  className?: string
}): ReactNode {
  return (
    <span
      className={cn("block max-w-full rounded-sm bg-muted animate-pulse", className)}
      style={{ width, height, ...SKELETON_PULSE_STYLE }}
    />
  )
}

