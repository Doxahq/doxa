import { activeTocIndex, tocScrollTargets, tocTriggers } from "@doxahq/docs-prose";
import { describe, expect, test } from "vitest";

import { HASH_SCROLL_SCRIPT, ROUTER_SCROLL_STORAGE_KEY } from "./hash-scroll-script";

interface Page {
  /** Heading tops in the scroll content, in TOC order. */
  tops: number[];
  readingOffset: number;
  viewportHeight: number;
  maxScroll: number;
  hash?: string;
  /** An element with an id that the TOC does not list. */
  extra?: { id: string; top: number };
  /** The router's saved positions, and the history entry key. */
  saved?: Record<string, Record<string, { scrollX: number; scrollY: number }>>;
  historyKey?: string;
}

const CONTAINER_ENTRY = '[data-scroll-restoration-id="docs-content"]';

/** Runs the inline script against a fake page. */
function runScript(page: Page): { scrollTop: number; active: number[] } {
  const root = {
    scrollTop: 0,
    clientHeight: page.viewportHeight,
    scrollHeight: page.maxScroll + page.viewportHeight,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => links,
  };
  const element = (id: string, top: number) => ({
    id,
    getBoundingClientRect: () => ({ top: top - root.scrollTop }),
  });
  const headings = page.tops.map((top, index) => element(`h${index}`, top));
  const links = page.tops.map((_, index) => {
    const attributes: Record<string, string> = { href: `#h${index}` };
    return {
      attributes,
      getAttribute: (name: string) => attributes[name] ?? null,
      setAttribute: (name: string, value: string) => (attributes[name] = value),
    };
  });
  const extra = page.extra ? element(page.extra.id, page.extra.top) : null;
  const document = {
    getElementById: (id: string) =>
      id === "app-scroll-container"
        ? root
        : (headings.find((heading) => heading.id === id) ?? (extra?.id === id ? extra : null)),
  };
  const sessionStorage = {
    getItem: (key: string) => (key === ROUTER_SCROLL_STORAGE_KEY && page.saved ? JSON.stringify(page.saved) : null),
  };
  new Function("document", "location", "getComputedStyle", "sessionStorage", "history", HASH_SCROLL_SCRIPT)(
    document,
    { hash: page.hash ?? "", pathname: "/databases", search: "" },
    () => ({ scrollMarginTop: `${page.readingOffset}px` }),
    sessionStorage,
    { state: page.historyKey ? { __TSR_key: page.historyKey } : null }
  );
  return {
    scrollTop: root.scrollTop,
    active: links.flatMap((link, index) => (link.attributes["data-active"] === "true" ? [index] : [])),
  };
}

/** Where the TOC scroll puts heading `index`, and the item the scroll spy marks there. */
function expected(page: Page, index: number) {
  const scrollTop = tocScrollTargets(page.tops, page)[index]!;
  return { scrollTop, active: activeTocIndex(tocTriggers(page.tops, page), scrollTop) };
}

// Measured on /databases at 2560x1400, where the last sections cannot reach
// the reading line and their triggers are pressed into the page end.
const tall: Page = {
  tops: [300, 460, 1486, 2561, 2825, 3657, 4026],
  readingOffset: 136,
  viewportHeight: 1400,
  maxScroll: 3329,
};

describe("scroll position and TOC item before the first paint", () => {
  test("a #hash lands where the TOC scroll puts it, with its item marked", () => {
    tall.tops.forEach((_, index) => {
      const result = runScript({ ...tall, hash: `#h${index}` });
      const want = expected(tall, index);
      expect(result.scrollTop).toBeCloseTo(want.scrollTop, 6);
      expect(result.active).toEqual([index]);
      expect(want.active).toBe(index);
    });
    expect(runScript({ ...tall, hash: "#h5" }).scrollTop).toBeCloseTo(3200.27, 1);
  });

  test("matches the TOC scroll and the scroll spy on many page shapes", () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 200; run++) {
      const tops: number[] = [];
      let top = 100 + random() * 400;
      const count = 1 + Math.floor(random() * 12);
      for (let index = 0; index < count; index++) {
        tops.push(Math.round(top));
        top += 40 + random() * 1200;
      }
      const viewportHeight = 600 + Math.round(random() * 900);
      const page = {
        tops,
        readingOffset: 80 + Math.round(random() * 80),
        viewportHeight,
        maxScroll: Math.max(0, Math.round(top - viewportHeight + random() * 300 - 150)),
      };
      const index = Math.floor(random() * count);
      const result = runScript({ ...page, hash: `#h${index}` });
      expect(result.scrollTop).toBeCloseTo(expected(page, index).scrollTop, 6);
      expect(result.active).toEqual([index]);

      // A refresh restores a saved position, and marks what the spy marks there.
      const scrollY = Math.round(random() * page.maxScroll);
      const restored = runScript({ ...page, historyKey: "k1", saved: { k1: { [CONTAINER_ENTRY]: { scrollX: 0, scrollY } } } });
      expect(restored.scrollTop).toBe(scrollY);
      expect(restored.active).toEqual([activeTocIndex(tocTriggers(tops, page), scrollY)]);
    }
  });

  test("a refresh without a hash restores the router's saved position", () => {
    const saved = { k1: { [CONTAINER_ENTRY]: { scrollX: 0, scrollY: 1800 } } };
    expect(runScript({ ...tall, historyKey: "k1", saved })).toEqual({ scrollTop: 1800, active: [2] });
    // An entry without a router key is saved under its path.
    expect(runScript({ ...tall, saved: { "/databases": saved.k1 } }).scrollTop).toBe(1800);
    // Another history entry, or nothing saved: the top, with the first item marked.
    expect(runScript({ ...tall, historyKey: "k2", saved })).toEqual({ scrollTop: 0, active: [0] });
    expect(runScript(tall)).toEqual({ scrollTop: 0, active: [0] });
  });

  test("an element outside the TOC scrolls to its own margin and marks the item there", () => {
    expect(runScript({ ...tall, hash: "#figure", extra: { id: "figure", top: 1800 } })).toEqual({
      scrollTop: 1800 - 136,
      active: [2],
    });
  });

  test("decodes the hash, and a missing target changes nothing", () => {
    expect(runScript({ ...tall, hash: "#%C3%A9tapes", extra: { id: "étapes", top: 900 } }).scrollTop).toBe(900 - 136);
    expect(runScript({ ...tall, hash: "#missing" })).toEqual({ scrollTop: 0, active: [0] });
  });
});
