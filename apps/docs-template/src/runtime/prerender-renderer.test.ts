import { describe, expect, test, vi } from "vitest";

import { preparePublicDocsRouteData } from "./prerender-renderer";
import type { DoxaDocsRuntimeSource } from "./runtime-source";

describe("public docs pre-render preparation", () => {
  test("prepares a page once and returns the strict browser contract", async () => {
    const getRouteData = vi.fn(async () => ({
      type: "page" as const,
      slug: "guide",
      href: "/guide",
      homeHref: "/guide",
      site: {
        name: "Demo",
        description: "Demo docs",
        url: "https://docs.example.com",
      },
      features: featureConfig,
      sections: [defaultSection],
      currentSection: defaultSection,
      sectionHomeHrefs: { docs: "/guide" },
      sectionNavigation: [{ title: "Guide", href: "/guide" }],
      sectionRoutes: [{ title: "Guide", href: "/guide" }],
      routeTitle: "Guide",
      sectionHeading: null,
      previous: null,
      next: null,
      page: {
        slug: "guide",
        href: "/guide",
        title: "Guide",
        description: "Read the guide",
        keywords: ["guide"],
        sectionSlug: "docs",
        sourcePath: "guide/index.mdx",
        body: "# Guide",
        headings: [{ level: 1, text: "Guide", href: "#guide" }],
      },
    }));
    const source = createSource(getRouteData);

    const result = await preparePublicDocsRouteData(source, "/guide");

    expect(result.type).toBe("page");
    expect(result.type === "page" && result.runtimeDocument?.ok).toBe(true);
    expect(getRouteData).toHaveBeenCalledOnce();
  });

  test("rejects a parse failure instead of publishing it as saved output", async () => {
    const source = createSource(async () => ({
      type: "page" as const,
      slug: "broken",
      href: "/broken",
      homeHref: "/broken",
      site: {
        name: "Demo",
        description: "Demo docs",
        url: "https://docs.example.com",
      },
      features: featureConfig,
      sections: [defaultSection],
      currentSection: defaultSection,
      sectionHomeHrefs: { docs: "/broken" },
      sectionNavigation: [{ title: "Broken", href: "/broken" }],
      sectionRoutes: [{ title: "Broken", href: "/broken" }],
      routeTitle: "Broken",
      sectionHeading: null,
      previous: null,
      next: null,
      page: {
        slug: "broken",
        href: "/broken",
        title: "Broken",
        description: "Broken docs",
        keywords: [],
        sectionSlug: "docs",
        sourcePath: "broken/index.mdx",
        body: "<Unknown />",
        headings: [],
      },
    }));

    await expect(preparePublicDocsRouteData(source, "/broken")).rejects.toThrow(
      "cannot be saved"
    );
  });
});

const defaultSection = {
  slug: "docs",
  label: "Docs",
  default: true,
  kind: "documentation" as const,
  layout: "docs" as const,
};

const featureConfig = {
  branding: true,
  rightSidebar: true,
  feedbackEdit: true,
  tableOfContents: true,
  scrollToTop: true,
  ai: { chat: false, chatWithPage: false, floatingInput: false },
  copyPage: { markdown: true, rawText: true },
  apiPlayground: true,
  rawMarkdown: true,
  loadFromGithub: false,
};

function createSource(
  getRouteData: NonNullable<DoxaDocsRuntimeSource["getRouteData"]>
): DoxaDocsRuntimeSource {
  const unsupported = async (): Promise<never> => {
    throw new Error("Unexpected legacy source operation");
  };
  return {
    getRouteData,
    getSiteConfig: unsupported,
    getCompanyConfig: unsupported,
    getSocialConfig: unsupported,
    getThemeConfig: unsupported,
    getFeatureConfig: unsupported,
    getSections: unsupported,
    getNavigation: unsupported,
    getRoutes: unsupported,
    getHomeHref: unsupported,
    resolvePage: unsupported,
    getPage: unsupported,
    getRawPage: unsupported,
    getSearchIndex: unsupported,
  };
}
