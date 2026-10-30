import type {
  DoxaDocsRuntimeSource,
  RuntimeNavPage,
  RuntimeSection,
} from "@/src/runtime/runtime-source";
import { RuntimeSourceError } from "@/src/runtime/runtime-source-error";
import { describe, expect, test, vi } from "vitest";

import { createSitemapResponse, formatSitemap, listSitemapUrls } from "./sitemap";

interface FakeSite {
  sections: RuntimeSection[];
  routes: Record<string, RuntimeNavPage[]>;
}

const ACME: FakeSite = {
  sections: [
    { slug: "docs", label: "Documentation", default: true },
    { slug: "api", label: "API Reference" },
    { slug: "internal", label: "Internal", hidden: true },
  ],
  routes: {
    docs: [
      { title: "Home", href: "/" },
      { title: "Install", href: "/install" },
      { title: "Usage", href: "/usage/" },
    ],
    api: [
      { title: "Usage", href: "/usage" },
      { title: "API overview", href: "/api" },
      { title: "Create a note", href: "/api/notes/create" },
    ],
    internal: [{ title: "Secret", href: "/internal/secret" }],
  },
};

function createSource(site: FakeSite): DoxaDocsRuntimeSource {
  const unsupported = async (): Promise<never> => {
    throw new Error("The sitemap must not call this operation.");
  };
  return {
    getSections: async () => site.sections,
    getRoutes: async (sectionSlug) => site.routes[sectionSlug] ?? [],
    getRawPage: vi.fn(unsupported),
    getResolvedSiteConfig: unsupported,
    getSiteConfig: unsupported,
    getCompanyConfig: unsupported,
    getSocialConfig: unsupported,
    getThemeConfig: unsupported,
    getFeatureConfig: unsupported,
    getNavigation: unsupported,
    getHomeHref: unsupported,
    resolvePage: unsupported,
    getPage: unsupported,
    getSearchIndex: unsupported,
  };
}

describe("listSitemapUrls", () => {
  test("lists each visible page once, on the requesting origin, without reading pages", async () => {
    const source = createSource(ACME);

    expect(await listSitemapUrls(source, "https://docs.acme.com")).toEqual([
      "https://docs.acme.com/",
      "https://docs.acme.com/install",
      "https://docs.acme.com/usage",
      "https://docs.acme.com/api",
      "https://docs.acme.com/api/notes/create",
    ]);
    expect(source.getRawPage).not.toHaveBeenCalled();
  });

  test("gives each hostname of a site its own URLs", async () => {
    const urls = await listSitemapUrls(createSource(ACME), "https://acme.doxa.page");

    expect(urls.every((url) => url.startsWith("https://acme.doxa.page/"))).toBe(true);
  });
});

describe("formatSitemap", () => {
  test("writes a sitemaps.org urlset and escapes XML", () => {
    expect(
      formatSitemap(["https://acme.doxa.page/", "https://acme.doxa.page/a?b=1&c=<2>"])
    ).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        "  <url><loc>https://acme.doxa.page/</loc></url>",
        "  <url><loc>https://acme.doxa.page/a?b=1&amp;c=&lt;2&gt;</loc></url>",
        "</urlset>",
        "",
      ].join("\n")
    );
  });
});

describe("createSitemapResponse", () => {
  test("answers XML with the pages of the requesting site", async () => {
    const response = await createSitemapResponse(
      new Request("https://docs.acme.com/sitemap.xml"),
      { runtimeSource: createSource(ACME) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("<loc>https://docs.acme.com/install</loc>");
    expect(body).not.toContain("docs.doxa.so");
    expect(body).not.toContain("/internal/secret");
  });

  test("answers 404 for a host without published docs", async () => {
    const source = createSource(ACME);
    source.getSections = async () => {
      throw new RuntimeSourceError("No published docs.", "project_not_found");
    };

    const response = await createSitemapResponse(
      new Request("https://docs.acme.com/sitemap.xml"),
      { runtimeSource: source }
    );

    expect(response.status).toBe(404);
  });
});
