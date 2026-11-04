import type { CSSProperties, ReactNode } from "react"
import { ChevronsUpDown } from "lucide-react"

import {
  PageListTop,
  PageSearchField,
  PagesHeading,
} from "~/components/dashboard/content/content-page-list-top"
import {
  ContentRowGuide,
  GROUP_LABEL_CLASS,
  PAGE_LABEL_CLASS,
  SECTION_LABEL_CLASS,
} from "~/components/dashboard/content/content-row-classes"
import {
  CONTENT_ROW_CHILD_DEPTH,
  contentRowIndent,
  type ContentRowDepth,
} from "~/components/dashboard/content/content-row-indent"
import { SidebarViewHeader } from "~/components/dashboard/shell/sidebar-view-stack"
import { SKELETON_PULSE_STYLE, useSkeletonPulse } from "~/lib/dashboard/skeleton-pulse"
import { cn } from "~/lib/utils"

/**
 * The Content view while the page list loads.
 *
 * It draws the real parts that need no data (the header, "PAGES", the search
 * box) with the components the list uses, and shimmering bars for the parts
 * that do (the branch, the tree). Each bar sits in the same box as the text it
 * stands for, with the row classes of the real tree, so nothing moves when the
 * list replaces it. Widths are percentages, so the bars follow the sidebar
 * width from 240px to 480px and in the mobile sheet.
 */
export function ContentSidebarSkeleton({ onBack }: { onBack: () => void }) {
  const ref = useSkeletonPulse<HTMLDivElement>()
  return (
    // A box for the shimmer clock that adds nothing to the layout. Inline, so
    // a dev server that missed a new utility class cannot break the column.
    <div ref={ref} style={{ display: "contents" }}>
      <SidebarViewHeader label="Content" backLabel="Back to overview" onBack={onBack}>
        <BranchSwitcherSkeleton />
      </SidebarViewHeader>
      <div role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col">
        <span className="sr-only">Loading pages</span>
        <PageListTop>
          <PagesHeading />
          {/* Inert: the box shows, but nothing can type into it until the list arrives. */}
          <div inert>
            <PageSearchField readOnly tabIndex={-1} aria-hidden="true" />
          </div>
        </PageListTop>
        <div aria-hidden="true" className="min-h-0 flex-1 overflow-hidden">
          <SectionSkeleton width="48%">
            <PageSkeleton depth={CONTENT_ROW_CHILD_DEPTH[0]} width="72%" />
            <PageSkeleton depth={CONTENT_ROW_CHILD_DEPTH[0]} width="58%" />
            <GroupSkeleton depth={CONTENT_ROW_CHILD_DEPTH[0]} width="46%">
              <PageSkeleton depth={2} width="76%" />
              <PageSkeleton depth={2} width="62%" />
              <PageSkeleton depth={2} width="70%" />
            </GroupSkeleton>
            <GroupSkeleton depth={CONTENT_ROW_CHILD_DEPTH[0]} width="34%" />
          </SectionSkeleton>
          <SectionSkeleton width="36%" />
          <SectionSkeleton width="28%" />
        </div>
      </div>
    </div>
  )
}

/** The branch switcher's box, with the branch name and status as bars. */
function BranchSwitcherSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid w-full grid-cols-[30px_minmax(0,1fr)_16px] items-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2"
    >
      <span className="grid size-[30px] place-items-center rounded-md border border-border bg-background">
        <Bar className="size-4 rounded-sm" />
      </span>
      <span className="min-w-0">
        <TextBar className="block font-mono text-[13px] font-medium" width="34%" />
        <TextBar className="mt-0.5 block text-[11.5px]" width="72%" />
      </span>
      <ChevronsUpDown aria-hidden="true" className="size-4 text-faint" />
    </div>
  )
}

function SectionSkeleton({ width, children }: { width: string; children?: ReactNode }) {
  return (
    <div>
      <div style={contentRowIndent(0)} className="flex">
        <span className={SECTION_LABEL_CLASS}>
          <Bar className="size-3.5 shrink-0 rounded-sm" />
          <TextBar className="min-w-0 flex-1" width={width} />
        </span>
      </div>
      {children ? (
        <div className="relative">
          <ContentRowGuide depth={CONTENT_ROW_CHILD_DEPTH[0]} />
          {children}
        </div>
      ) : null}
    </div>
  )
}

function GroupSkeleton({
  depth,
  width,
  children,
}: {
  depth: ContentRowDepth
  width: string
  children?: ReactNode
}) {
  return (
    <div>
      <div style={contentRowIndent(depth)} className="flex">
        <span className={GROUP_LABEL_CLASS}>
          <Bar className="size-3 shrink-0 rounded-sm" />
          <TextBar className="min-w-0 flex-1" width={width} />
        </span>
      </div>
      {children ? (
        <div className="relative">
          <ContentRowGuide depth={CONTENT_ROW_CHILD_DEPTH[depth]} />
          {children}
        </div>
      ) : null}
    </div>
  )
}

function PageSkeleton({ depth, width }: { depth: ContentRowDepth; width: string }) {
  return (
    <div style={contentRowIndent(depth)} className="flex">
      <span className={PAGE_LABEL_CLASS}>
        <Bar className="size-4 shrink-0 rounded-sm" />
        <TextBar className="min-w-0 flex-1 text-[13.5px]" width={width} />
      </span>
    </div>
  )
}

/**
 * A bar that stands for one line of text. The zero-width space gives it the
 * line box of real text in the same font classes, so the row height matches.
 *
 * The bar's size is inline, not utility classes. Tailwind emits a class only
 * when it finds it in the source, and a dev server that missed a new class
 * draws the bar 0px tall (see `content-row-indent.ts`).
 */
function TextBar({ className, width }: { className?: string; width: string }) {
  return (
    <span className={className}>
      <Bar className="inline-block max-w-full rounded-sm align-middle" style={{ width, height: "0.8em" }} />
      {ZERO_WIDTH_SPACE}
    </span>
  )
}

const ZERO_WIDTH_SPACE = "\u200b"

function Bar({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      style={{ ...style, ...SKELETON_PULSE_STYLE }}
      className={cn("block bg-muted motion-safe:animate-pulse", className)}
    />
  )
}
