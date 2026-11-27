import { createElement, type ComponentProps } from "react";
import { resolveSiteConfig, toClientSiteConfig } from "@doxahq/site-config";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SiteConfigProvider } from "../../site-config/site-config-context";
import { ArticleEnd } from "./article-end";

// Keeps only the anchor attributes. The router's preload props are no DOM props.
vi.mock("../../lib/transition", () => ({
  Link: ({ rel, href, title, className, children }: ComponentProps<"a">) =>
    createElement("a", { rel, href, title, className }, children),
}));

const QUICKSTART = { title: "Quickstart", href: "/quickstart" };

function renderArticleEnd(next: typeof QUICKSTART | null = QUICKSTART) {
  return renderToStaticMarkup(
    createElement(SiteConfigProvider, {
      config: toClientSiteConfig(resolveSiteConfig({})),
      children: createElement(ArticleEnd, {
        pathname: "overview",
        previous: null,
        next,
      }),
    })
  );
}

describe("article end", () => {
  it("shows the next page card and leaves the credit to the footer", () => {
    const html = renderArticleEnd();

    expect(html).toContain('rel="next"');
    expect(html).not.toContain("Powered by");
  });

  it("renders no page links on a page without neighbors", () => {
    expect(renderArticleEnd(null)).not.toContain("<nav");
  });
});
