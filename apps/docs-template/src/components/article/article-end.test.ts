import { createElement, type ComponentProps } from "react";
import {
  resolveSiteConfig,
  toClientSiteConfig,
  type SiteConfigInput,
} from "@doxahq/site-config";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DemoModeProvider } from "../../contexts/demo-mode";
import { SiteConfigProvider } from "../../site-config/site-config-context";
import { ArticleEnd } from "./article-end";

// Keeps only the anchor attributes. The router's preload props are no DOM props.
vi.mock("../../lib/transition", () => ({
  Link: ({ rel, href, title, className, children }: ComponentProps<"a">) =>
    createElement("a", { rel, href, title, className }, children),
}));

const QUICKSTART = { title: "Quickstart", href: "/quickstart" };

function renderArticleEnd({
  config = {},
  demo = false,
  next = QUICKSTART,
}: {
  config?: SiteConfigInput;
  demo?: boolean;
  next?: typeof QUICKSTART | null;
} = {}) {
  return renderToStaticMarkup(
    createElement(DemoModeProvider, {
      value: demo,
      children: createElement(SiteConfigProvider, {
        config: toClientSiteConfig(resolveSiteConfig(config)),
        children: createElement(ArticleEnd, {
          pathname: "overview",
          previous: null,
          next,
        }),
      }),
    })
  );
}

describe("article end", () => {
  it("shows the Powered by Doxa credit on the right, above the next page card", () => {
    const html = renderArticleEnd();

    expect(html).toMatch(
      /<a href="https:\/\/doxa\.so"[^>]*class="[^"]*self-end/
    );
    expect(html.indexOf("Powered by")).toBeLessThan(html.indexOf('rel="next"'));
  });

  it("hides the credit when the site turns it off", () => {
    const html = renderArticleEnd({
      config: { branding: { poweredBy: false } },
    });

    expect(html).not.toContain("Powered by");
    expect(html).toContain('rel="next"');
  });

  it("hides the credit in the demo, like the footer", () => {
    expect(renderArticleEnd({ demo: true })).not.toContain("Powered by");
  });

  it("keeps the credit on a page without neighbors", () => {
    const html = renderArticleEnd({ next: null });

    expect(html).toContain("Powered by");
    expect(html).not.toContain("<nav");
  });
});
