/**
 * The drawn height of each locked MDX block, by its source.
 *
 * A block preview shows a placeholder on its first frame and draws in the
 * next one (see `MdxPreview`). The placeholder takes the height the same
 * source had before, so a page opened again does not move when its blocks
 * draw. A source not seen yet gets an estimate from its line count.
 */

const HEIGHT_LIMIT = 300
const heights = new Map<string, number>()

/** About one line of article text, in pixels. */
const LINE_HEIGHT = 28

export function rememberBlockPreviewHeight(source: string, height: number): void {
  if (!Number.isFinite(height) || height < 0) return
  heights.delete(source)
  heights.set(source, height)
  while (heights.size > HEIGHT_LIMIT) heights.delete(heights.keys().next().value!)
}

/** The height to hold for a block that has not drawn yet. */
export function blockPreviewHeight(source: string): number {
  return heights.get(source) ?? estimateBlockPreviewHeight(source)
}

function estimateBlockPreviewHeight(source: string): number {
  const lines = source.split("\n").filter((line) => line.trim().length > 0).length
  return Math.max(1, lines) * LINE_HEIGHT
}
