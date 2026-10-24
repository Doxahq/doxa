import type { CSSProperties } from "react"

/**
 * Indentation scale for the content sidebar tree.
 *
 * Depth 0 is a top-level row. Each step is wide enough to read against the
 * full-width row borders.
 *
 * The padding is inline rather than a utility class. Tailwind emits a class
 * only when it finds that exact class in the source, and a class picked from a
 * lookup table can be missed. A missed class puts the row flush left, which is
 * the fault this scale exists to prevent.
 */
export type ContentRowDepth = 0 | 1 | 2

const ROW_INDENT_REM: Record<ContentRowDepth, number> = {
  0: 0.625,
  1: 2,
  2: 3.375,
}

/** The depth of the rows nested inside a row at this depth. */
export const CONTENT_ROW_CHILD_DEPTH: Record<ContentRowDepth, ContentRowDepth> = {
  0: 1,
  1: 2,
  2: 2,
}

/**
 * Where the content of a row at this depth starts, in rem from the row's left
 * edge. The drop line and the carried row start here too.
 */
export function contentRowIndentRem(depth: ContentRowDepth): number {
  return ROW_INDENT_REM[depth]
}

/** Left padding for a row at this depth. */
export function contentRowIndent(depth: ContentRowDepth): CSSProperties {
  return { paddingLeft: `${contentRowIndentRem(depth)}rem` }
}

/**
 * Guide line offset for a region that holds rows at this depth.
 *
 * The line sits one step to the left of its rows, so it runs down the branch
 * without crossing an icon.
 */
export function contentRowGuideOffset(depth: ContentRowDepth): CSSProperties {
  return { left: `${ROW_INDENT_REM[depth] - ROW_INDENT_REM[0]}rem` }
}
