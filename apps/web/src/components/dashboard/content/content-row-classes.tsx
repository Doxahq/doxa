import {
  contentRowGuideOffset,
  type ContentRowDepth,
} from "~/components/dashboard/content/content-row-indent"

/**
 * Row geometry shared by the content tree, its drop preview, and the loading
 * skeleton. This module stays small, because the always-loaded sidebar reads
 * it for the skeleton.
 */
export const SECTION_LABEL_CLASS =
  "flex min-w-0 flex-1 items-center gap-2 py-2 font-mono text-[10.5px] font-medium tracking-[0.16em] uppercase transition-colors"
export const GROUP_LABEL_CLASS =
  "flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-[13.5px] font-medium transition-colors"
/** The geometry of a page row's label. */
export const PAGE_LABEL_CLASS =
  "flex min-w-0 flex-1 items-center gap-2 py-[5px] text-left transition-colors"

/**
 * The vertical line that runs down one branch.
 *
 * It is an overlay, so the hover background of a row still spans the whole
 * sidebar. A top-level region draws no line, because it has no parent.
 */
export function ContentRowGuide({ depth }: { depth: ContentRowDepth }) {
  if (depth === 0) return null

  return (
    <span
      aria-hidden="true"
      style={contentRowGuideOffset(depth)}
      className="pointer-events-none absolute inset-y-0 w-px bg-divider"
    />
  )
}
