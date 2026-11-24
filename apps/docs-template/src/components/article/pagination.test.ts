import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Pagination } from "./pagination";

// Keeps only the anchor attributes. The router's preload props are no DOM props.
vi.mock("../../lib/transition", () => ({
  Link: ({ rel, href, title, className, children }: ComponentProps<"a">) =>
    createElement("a", { rel, href, title, className }, children),
}));

const INTRODUCTION = { title: "Introduction", href: "/introduction" };
const QUICKSTART = { title: "Quickstart", href: "/quickstart" };

function renderPagination(props: Partial<ComponentProps<typeof Pagination>>) {
  return renderToStaticMarkup(
    createElement(Pagination, { pathname: "architecture", ...props })
  );
}

describe("page pagination", () => {
  it("links the previous and the next page", () => {
    const html = renderPagination({ previous: INTRODUCTION, next: QUICKSTART });

    expect(html).toMatch(/rel="prev" href="\/introduction"/);
    expect(html).toMatch(/rel="next" href="\/quickstart"/);
    expect(html).toContain('title="Next: Quickstart"');
  });

  it("keeps a lone next card in the right column", () => {
    const html = renderPagination({ previous: null, next: QUICKSTART });

    expect(html).not.toContain('rel="prev"');
    expect(html).toMatch(/rel="next"[^>]*class="[^"]*col-start-2/);
  });

  it("renders nothing when the page has no neighbors", () => {
    expect(renderPagination({ previous: null, next: null })).toBe("");
  });
});
