/**
 * Which heading a table of contents marks as current. The published docs
 * site and the dashboard's Write editor both use it, so the two agree.
 *
 * A heading becomes current when its top scrolls up to the reading line, a
 * fixed distance below the top of the view. Headings near the end of the page
 * can never reach that line, because the page stops scrolling first. Without
 * help, the last short sections are never marked.
 *
 * So the scroll offsets at which those last headings become current (their
 * triggers) are pressed into the last stretch of scroll, in page order and
 * in proportion to their distance. Every heading gets its own scroll range,
 * and the last heading becomes current at the bottom of the page. A heading
 * never becomes current later than it does with the plain reading line, so
 * it is always in view when it is marked.
 *
 * To scroll to a heading, use `tocScrollTargets`. The heading is then current
 * when the scroll stops, even a heading that cannot reach the reading line.
 */

/** Sub-pixel scroll positions can stop short of the exact end by up to a pixel. */
const SCROLL_TOLERANCE = 1;

export interface TocScrollMetrics {
  /** `scrollHeight - clientHeight` of the scroll container. */
  maxScroll: number;
  /** `clientHeight` of the scroll container. */
  viewportHeight: number;
  /** The distance of the reading line below the top of the view, in pixels. */
  readingOffset: number;
}

/**
 * The scroll offset at which each heading becomes current.
 *
 * @param tops Each heading's top in the scroll content, in page order.
 */
export function tocTriggers(
  tops: number[],
  { maxScroll, viewportHeight, readingOffset }: TocScrollMetrics,
): number[] {
  const natural = tops.map((top) => Math.max(0, top - readingOffset));
  const last = natural.at(-1);
  // A page that does not scroll, or one where every heading reaches the line,
  // keeps the plain triggers.
  if (
    last === undefined ||
    maxScroll <= SCROLL_TOLERANCE ||
    last <= maxScroll - SCROLL_TOLERANCE
  ) {
    return natural;
  }

  // Content below `maxScroll + readingOffset` never reaches the line. It is at
  // most `viewportHeight - readingOffset` tall, so a stretch of scroll that
  // long holds the tail at no less than half its natural spacing.
  const end = maxScroll - SCROLL_TOLERANCE;
  const start = Math.max(0, end - Math.max(viewportHeight - readingOffset, 0));
  const scale = (end - start) / (last - start);
  return natural.map((trigger) =>
    trigger <= start ? trigger : start + (trigger - start) * scale,
  );
}

/** The index of the current heading: the last one whose trigger the scroll passed. */
export function activeTocIndex(triggers: number[], scrollTop: number): number {
  let active = 0;
  triggers.forEach((trigger, index) => {
    if (trigger <= scrollTop + SCROLL_TOLERANCE) active = index;
  });
  return active;
}

/**
 * Where to scroll to show each heading: as near the reading line as the page
 * allows, with that heading still current when the scroll stops. A heading
 * near the end of the page stops no later than the middle of its own scroll
 * range, so a small scroll after the jump does not move the mark.
 *
 * @param tops Each heading's top in the scroll content, in page order.
 */
export function tocScrollTargets(
  tops: number[],
  metrics: TocScrollMetrics,
): number[] {
  const triggers = tocTriggers(tops, metrics);
  return tops.map((top, index) => {
    const trigger = triggers[index]!;
    const next = triggers[index + 1];
    const latest =
      next === undefined ? Number.POSITIVE_INFINITY : (trigger + next) / 2;
    const wanted = Math.min(top - metrics.readingOffset, metrics.maxScroll);
    return Math.max(trigger, Math.min(wanted, latest));
  });
}
