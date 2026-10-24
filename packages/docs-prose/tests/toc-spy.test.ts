import { describe, expect, test } from "vitest";

import { activeTocIndex, tocScrollTargets, tocTriggers } from "../src/toc-spy";

const VIEWPORT = 800;
const READING_OFFSET = 96;

function triggersFor(tops: number[], scrollHeight: number): number[] {
  return tocTriggers(tops, {
    maxScroll: scrollHeight - VIEWPORT,
    viewportHeight: VIEWPORT,
    readingOffset: READING_OFFSET,
  });
}

/** Walks the whole scroll range and lists the headings in the order they become current. */
function marked(tops: number[], scrollHeight: number): number[] {
  const triggers = triggersFor(tops, scrollHeight);
  const seen: number[] = [];
  for (let scrollTop = 0; scrollTop <= scrollHeight - VIEWPORT; scrollTop += 1) {
    const index = activeTocIndex(triggers, scrollTop);
    if (seen.at(-1) !== index) seen.push(index);
  }
  return seen;
}

// Three long sections, then three short ones in the last screen: none of the
// short ones reaches the reading line.
const END_HEAVY_TOPS = [100, 1000, 2400, 2520, 2640, 2760];
const END_HEAVY_HEIGHT = 3000;

describe("tocTriggers", () => {
  test("keeps the reading line when every heading reaches it", () => {
    const tops = [100, 1200, 2400];
    expect(triggersFor(tops, 4800)).toEqual(tops.map((top) => top - READING_OFFSET));
  });

  test("marks every short section at the end of the page, in order", () => {
    expect(marked(END_HEAVY_TOPS, END_HEAVY_HEIGHT)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("gives each end heading a usable stretch of scroll", () => {
    const triggers = triggersFor(END_HEAVY_TOPS, END_HEAVY_HEIGHT);
    for (let index = 3; index < triggers.length; index += 1) {
      expect(triggers[index]! - triggers[index - 1]!).toBeGreaterThanOrEqual(50);
    }
  });

  test("marks the last heading at the bottom, even a pixel short of it", () => {
    const maxScroll = END_HEAVY_HEIGHT - VIEWPORT;
    const triggers = triggersFor([100, 2400, 2900], END_HEAVY_HEIGHT);
    expect(activeTocIndex(triggers, maxScroll - 0.5)).toBe(2);
    expect(activeTocIndex(triggers, maxScroll - 40)).toBe(1);
  });

  test("never marks a heading later than the plain reading line", () => {
    const triggers = triggersFor(END_HEAVY_TOPS, END_HEAVY_HEIGHT);
    triggers.forEach((trigger, index) =>
      expect(trigger).toBeLessThanOrEqual(END_HEAVY_TOPS[index]! - READING_OFFSET),
    );
  });


  test("keeps a page that does not scroll on its first heading", () => {
    const triggers = tocTriggers([40, 300, 500], {
      maxScroll: 0,
      viewportHeight: VIEWPORT,
      readingOffset: READING_OFFSET,
    });
    expect(activeTocIndex(triggers, 0)).toBe(0);
  });

  test("marks the first heading above the first trigger", () => {
    expect(activeTocIndex([400, 900], 0)).toBe(0);
  });
});

describe("tocScrollTargets", () => {
  const metrics = {
    maxScroll: END_HEAVY_HEIGHT - VIEWPORT,
    viewportHeight: VIEWPORT,
    readingOffset: READING_OFFSET,
  };

  test("leaves each heading current when the scroll stops", () => {
    const triggers = triggersFor(END_HEAVY_TOPS, END_HEAVY_HEIGHT);
    tocScrollTargets(END_HEAVY_TOPS, metrics).forEach((target, index) =>
      expect(activeTocIndex(triggers, target)).toBe(index),
    );
  });

  test("puts a heading on the reading line when the page allows it", () => {
    const targets = tocScrollTargets(END_HEAVY_TOPS, metrics);
    expect(targets[0]).toBe(END_HEAVY_TOPS[0]! - READING_OFFSET);
    expect(targets[1]).toBe(END_HEAVY_TOPS[1]! - READING_OFFSET);
  });

  test("stops an end heading with room to scroll either way", () => {
    const triggers = triggersFor(END_HEAVY_TOPS, END_HEAVY_HEIGHT);
    tocScrollTargets(END_HEAVY_TOPS, metrics).forEach((target, index) => {
      const next = triggers[index + 1];
      if (next !== undefined && triggers[index] !== END_HEAVY_TOPS[index]! - READING_OFFSET) {
        expect(activeTocIndex(triggers, target + 20)).toBe(index);
      }
    });
  });

  test("never scrolls past the end of the page", () => {
    for (const target of tocScrollTargets(END_HEAVY_TOPS, metrics)) {
      expect(target).toBeLessThanOrEqual(metrics.maxScroll);
    }
  });
});
