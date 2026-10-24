import type {
  RuntimeMdxElementNode,
  RuntimeMdxNode,
} from "@doxahq/mdx-runtime";
import { getDocsHighlighter } from "@doxahq/mdx-runtime/highlight";
import { afterEach, describe, expect, test, vi } from "vitest";

import { getDemoRedirectSearch } from "./demo-search";
import {
  findSectionHeadingFromRuntimeNavigation,
  getDocsRouteDataFromMatches,
  getPreviousNextFromRuntimeRoutes,
  parseDocsRouteDocument,
  resolveDocsRootRouteData,
  resolveDocsRouteData,
  RUNTIME_MDX_PARSE_ERROR_CODE,
} from "./docs-route-data";
import {
  filterLinkableRuntimePages,
  normalizeRuntimeHref,
  normalizeRuntimeSlug,
  type DoxaDocsRuntimeSource,
  type RuntimeFeatureConfig,
  type RuntimeNavNode,
  type RuntimePage,
  type RuntimeRawPage,
  type RuntimeSection,
} from "./runtime-source";

describe("docs route data", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("resolves root route data as the canonical home page", async () => {
    const source = createFakeRuntimeSource();

    await expect(resolveDocsRouteData(source, "/")).resolves.toMatchObject({
      type: "redirect",
      href: "/overview",
      status: 308,
    });

    await expect(resolveDocsRootRouteData(source)).resolves.toMatchObject({
      type: "page",
      href: "/overview",
      slug: "overview",
      canonicalUrl: "https://docs.example.com/overview",
      document: {
        href: "/overview",
        frontmatter: { title: "Overview" },
      },
    });
  });

  test("preserves demo search payload for redirects", () => {
    expect(getDemoRedirectSearch({ demo: "" })).toEqual({
      search: { demo: true },
    });
    expect(getDemoRedirectSearch({ demo: "false" })).toEqual({});
  });

  test("marks default-prefixed pages for router notFound", async () => {
    await expect(
      resolveDocsRouteData(createFakeRuntimeSource(), "/default/overview")
    ).resolves.toMatchObject({
      type: "router_not_found",
      href: "/default/overview",
      slug: "default/overview",
    });
  });

  test("keeps ordinary missing pages as in-page not-found data", async () => {
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource(),
      "/missing"
    );

    expect(data).toMatchObject({
      type: "not_found",
      href: "/missing",
      slug: "missing",
      document: null,
      rawDoc: null,
    });
  });

  test("resolves page metadata, toc, canonical URL, routes, and raw copy data", async () => {
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource(),
      "/overview",
      { includeRawDocument: true }
    );

    expect(data.type).toBe("page");
    if (data.type !== "page") return;

    expect(data.document).toMatchObject({
      href: "/overview",
      slug: "overview",
      sourcePath: "overview/index.mdx",
      frontmatter: {
        title: "Overview",
        description: "Start here.",
        keywords: "intro, doxa",
      },
      tocs: [{ level: 2, text: "Install", href: "#install" }],
    });
    expect(data.routeTitle).toBe("Overview Route");
    expect(data.sectionHeading).toBe("Start");
    expect(data.canonicalUrl).toBe("https://docs.example.com/overview");
    expect(data.homeHref).toBe("/overview");
    expect(data.rawDoc?.body.trim()).toBe("# Overview\n\nBody.");
    expect(data.previous).toBeNull();
    expect(data.next?.href).toBe("/guide");
    expect(data.sectionRoutes.map((route) => route.href)).toEqual([
      "/overview",
      "/guide",
      "/advanced",
    ]);
  });

  test("excludes raw document data from normal route data by default", async () => {
    let rawPageCalls = 0;
    const source = createFakeRuntimeSource({
      async getRawPage(slugOrHref) {
        rawPageCalls++;
        return rawPages[normalizeRuntimeHref(slugOrHref)] ?? null;
      },
    });

    const data = await resolveDocsRouteData(source, "/overview");

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.rawDoc).toBeNull();
    expect(data.runtimeDocument).toBeNull();
    expect(rawPageCalls).toBe(0);
  });

  test("can include runtime page documents for platform routes", async () => {
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource(),
      "/overview",
      { includeRuntimeDocument: true }
    );

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.runtimeDocument?.ok).toBe(true);
    if (!data.runtimeDocument?.ok) return;
    expect(data.runtimeDocument.document.nodes).toContainEqual({
      type: "element",
      name: "h1",
      props: { id: "overview" },
      children: [{ type: "text", value: "Overview" }],
    });
  });

  test("highlights supported fences in parsed route documents", () => {
    const result = parseDocsRouteDocument(
      '```bash\necho "route"\n```',
      "/reference/route",
      getDocsHighlighter()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      findRuntimeElement(result.document.nodes, "pre")?.props?.className
    ).toContain("shiki");
  });

  test("pins uploaded images to the content hash the runtime sent", () => {
    const sha256 = "c".repeat(64);
    const result = parseDocsRouteDocument(
      "![Diagram](/assets/diagram.png)\n\n![Other](/assets/other.png)",
      "/guide",
      undefined,
      { "diagram.png": sha256 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sources = result.document.nodes.flatMap((node) =>
      node.type === "element"
        ? (node.children ?? []).flatMap((child) =>
            child.type === "element" && child.name === "img"
              ? [child.props?.src]
              : []
          )
        : []
    );
    expect(sources).toEqual([
      `/assets/diagram.png?v=${sha256}`,
      "/assets/other.png",
    ]);
  });

  test("keeps runtime fence text for the platform copy button", async () => {
    const pageWithCode: RuntimePage = {
      ...pages["/overview"],
      body: "```bash\necho platform\n```",
    };
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource({
        async resolvePage() {
          return {
            type: "page",
            href: pageWithCode.href,
            slug: pageWithCode.slug,
            page: pageWithCode,
          };
        },
      }),
      "/overview",
      { includeRuntimeDocument: true }
    );

    expect(data.type).toBe("page");
    if (data.type !== "page" || !data.runtimeDocument?.ok) return;
    expect(
      findRuntimeElement(data.runtimeDocument.document.nodes, "pre")?.props?.raw
    ).toBe("echo platform");
  });

  test("carries REST frontmatter metadata into route documents", async () => {
    const endpointPage: RuntimePage = {
      ...pages["/overview"],
      title: "Get a user",
      apiMethod: "GET",
      apiPath: "/v1/users/{userId}",
      body: `---
title: Get a user
description: Return one public user.
apiMethod: GET
apiPath: /v1/users/{userId}
---

# User`,
    };
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource({
        async resolvePage() {
          return {
            type: "page",
            href: endpointPage.href,
            slug: endpointPage.slug,
            page: endpointPage,
          };
        },
      }),
      "/overview",
      { includeRuntimeDocument: true }
    );

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.document?.frontmatter).toMatchObject({
      apiMethod: "GET",
      apiPath: "/v1/users/{userId}",
    });
    expect(data.runtimeDocument).toMatchObject({
      ok: true,
      document: {
        frontmatter: {
          apiMethod: "GET",
          apiPath: "/v1/users/{userId}",
        },
      },
    });
  });

  test("parses runtime documents for endpoint pages without the platform flag", async () => {
    const endpointPage: RuntimePage = {
      ...pages["/overview"],
      title: "Get a user",
      apiMethod: "GET",
      apiPath: "/v1/users/{userId}",
      body: `---
title: Get a user
apiMethod: GET
apiPath: /v1/users/{userId}
---

# User`,
    };

    // The reference layout needs the parsed node tree to split the samples into
    // the rail and to mount the request playground. Without this, an endpoint
    // page in vite mode falls back to the plain article layout.
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource({
        async resolvePage() {
          return {
            type: "page",
            href: endpointPage.href,
            slug: endpointPage.slug,
            page: endpointPage,
          };
        },
      }),
      "/overview"
    );

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.runtimeDocument?.ok).toBe(true);
  });

  test("skips runtime parsing for non-endpoint pages without the platform flag", async () => {
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource(),
      "/overview"
    );

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.runtimeDocument).toBeNull();
  });

  test("builds the table of contents from the parsed page, so its links match the heading anchors", async () => {
    const page = {
      ...pages["/overview"],
      body: "# Overview\n\n## Symptoms\n\n### `init()` fails\n\n## Symptoms\n",
      // The runtime's own list repeats an anchor, so one link cannot work.
      headings: [
        { level: 2, text: "Symptoms", href: "#symptoms" },
        { level: 3, text: "`init()` fails", href: "#init-fails" },
        { level: 2, text: "Symptoms", href: "#symptoms" },
      ],
    };
    const source = createFakeRuntimeSource({
      async resolvePage() {
        return { type: "page", href: page.href, slug: page.slug, page };
      },
    });

    const data = await resolveDocsRouteData(source, "/overview", {
      includeRuntimeDocument: true,
    });

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.document?.tocs).toEqual([
      { level: 2, text: "Symptoms", href: "#symptoms" },
      { level: 3, text: "init() fails", href: "#init-fails" },
      { level: 2, text: "Symptoms", href: "#symptoms-1" },
    ]);
    if (!data.runtimeDocument?.ok) throw new Error("expected a parsed page");
    const anchors = data.runtimeDocument.document.nodes.flatMap((node) =>
      node.type === "element" && /^h[2-4]$/.test(node.name) ? [`#${node.props?.id}`] : []
    );
    expect(anchors).toEqual(data.document?.tocs.map((toc) => toc.href));

    // Without a parsed page, the runtime's list stays.
    const plain = await resolveDocsRouteData(source, "/overview");
    if (plain.type !== "page") return;
    expect(plain.document?.tocs).toEqual(page.headings);
  });

  test("preserves and logs runtime parser failures instead of swallowing them", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const invalidPage = {
      ...pages["/overview"],
      body: "# Overview\n\n<Warning>Do not publish.</Warning>",
    };
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource({
        async resolvePage() {
          return {
            type: "page",
            href: invalidPage.href,
            slug: invalidPage.slug,
            page: invalidPage,
          };
        },
      }),
      "/overview",
      { includeRuntimeDocument: true }
    );

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.runtimeDocument).toMatchObject({
      ok: false,
      code: RUNTIME_MDX_PARSE_ERROR_CODE,
      error: expect.stringContaining("Unknown MDX component: Warning"),
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "Runtime MDX parse failed for /overview: Failed to parse runtime MDX"
      )
    );
  });

  test("uses one-shot runtime route data when available", async () => {
    const resolvePage = vi.fn(async () => {
      throw new Error("legacy route waterfall should not be used");
    });
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource({
        resolvePage,
        async getRouteData() {
          return {
            type: "page",
            slug: "overview",
            href: "/overview",
            homeHref: "/overview",
            site: {
              name: "Doxa Test",
              description: "Generated docs.",
              url: "https://docs.example.com",
            },
            features: featureConfig,
            sections,
            currentSection: sections[0],
            sectionHomeHrefs: { docs: "/overview" },
            sectionNavigation: [
              { heading: "Start" },
              { title: "Overview Route", href: "/overview" },
            ],
            sectionRoutes: [
              { title: "Overview Route", href: "/overview" },
              { title: "Guide", href: "/guide" },
            ],
            routeTitle: "Overview Route",
            sectionHeading: "Start",
            previous: null,
            next: { title: "Guide", href: "/guide" },
            page: pages["/overview"],
          };
        },
      }),
      "/overview",
      { includeRuntimeDocument: true }
    );

    expect(resolvePage).not.toHaveBeenCalled();
    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.routeTitle).toBe("Overview Route");
    expect(data.sectionHeading).toBe("Start");
    expect(data.next?.href).toBe("/guide");
    expect(data.runtimeDocument?.ok).toBe(true);
    if (!data.runtimeDocument?.ok) return;
    expect(data.runtimeDocument.document.nodes).toContainEqual({
      type: "element",
      name: "h1",
      props: { id: "overview" },
      children: [{ type: "text", value: "Overview" }],
    });
  });

  test("falls back when one-shot runtime route data is not supported yet", async () => {
    const resolvePage = vi.fn(async (pathname: string) => {
      const href = normalizeRuntimeHref(pathname);
      return {
        type: "page" as const,
        href,
        slug: normalizeRuntimeSlug(href),
        page: pages[href],
      };
    });
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource({
        resolvePage,
        async getRouteData() {
          throw new Error(
            '[platform-runtime-source] getRouteData failed with 400: {"ok":false,"error":{"code":"invalid_request"}}'
          );
        },
      }),
      "/overview"
    );

    expect(resolvePage).toHaveBeenCalledTimes(1);
    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.document?.href).toBe("/overview");
  });

  test("emits opt-in timing for route data resolution", async () => {
    const events: string[] = [];
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource(),
      "/overview",
      {
        timing: {
          enabled: true,
          mark(event) {
            events.push(event);
          },
          async measure(event, operation) {
            events.push(event);
            return operation();
          },
        },
      }
    );

    expect(data.type).toBe("page");
    expect(events).toContain("route.resolvePage");
    expect(events).toContain("route.getSiteConfig");
    expect(events).toContain("route.getNavigation");
    expect(events).toContain("route.getSectionHomeHrefs");
    expect(events).toContain("route.complete");
  });

  test("resolves a canonical root document as page data", async () => {
    const source = createFakeRuntimeSource({
      async getHomeHref() {
        return "/";
      },
      async resolvePage() {
        return {
          type: "page",
          href: "/",
          slug: "",
          page: createPage({ href: "/", title: "Home" }),
        };
      },
    });

    await expect(
      resolveDocsRootRouteData(source, { includeRuntimeDocument: true })
    ).resolves.toMatchObject({
      type: "page",
      href: "/",
      slug: "",
      document: {
        href: "/",
        frontmatter: { title: "Home" },
      },
      runtimeDocument: { ok: true },
    });
  });

  test("does not return root self-redirects", async () => {
    await expect(
      resolveDocsRootRouteData(
        createFakeRuntimeSource({
          async resolvePage() {
            return { type: "redirect", href: "/", status: 308 };
          },
        })
      )
    ).resolves.toEqual({
      type: "empty",
      homeHref: "/",
    });
  });

  test("keeps page data available when raw copy loading fails", async () => {
    const source = createFakeRuntimeSource({
      async getRawPage() {
        throw new Error("raw copy unavailable");
      },
    });

    const data = await resolveDocsRouteData(source, "/overview", {
      includeRawDocument: true,
    });

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.document?.href).toBe("/overview");
    expect(data.rawDoc).toBeNull();
  });

  test("flattens nested section navigation for sidebar consumers", async () => {
    const nestedNavigation: RuntimeNavNode[] = [
      { heading: "Start" },
      {
        title: "Guide",
        href: "/guide",
        items: [{ title: "Install", href: "/install" }],
      },
    ];
    const source = createFakeRuntimeSource({
      async getNavigation(sectionSlug) {
        return sectionSlug === "docs" ? nestedNavigation : [];
      },
      async getRoutes(sectionSlug) {
        return filterLinkableRuntimePages(
          sectionSlug === "docs" ? nestedNavigation : []
        );
      },
    });

    const data = await resolveDocsRouteData(source, "/guide");

    expect(data.type).toBe("page");
    if (data.type !== "page") return;
    expect(data.sectionNavigation).toEqual([
      { heading: "Start" },
      { title: "Guide", href: "/guide" },
      { title: "Install", href: "/guide/install" },
    ]);
    expect(data.sectionRoutes.map((route) => route.href)).toEqual([
      "/guide",
      "/guide/install",
    ]);
  });

  test("selects docs route data from router matches for root-level navigation", async () => {
    const data = await resolveDocsRouteData(
      createFakeRuntimeSource(),
      "/overview"
    );

    expect(
      getDocsRouteDataFromMatches([
        { loaderData: { type: "empty" } },
        { loaderData: data },
      ])
    ).toBe(data);
    expect(
      getDocsRouteDataFromMatches([
        { loaderData: null },
        { loaderData: { type: "redirect", href: "/overview", status: 308 } },
      ])
    ).toBeNull();
  });

  test("derives section headings and pagination from runtime navigation/routes", async () => {
    const source = createFakeRuntimeSource();
    const navigation = await source.getNavigation("docs");
    const routes = await source.getRoutes("docs");

    expect(
      findSectionHeadingFromRuntimeNavigation(navigation, "/advanced")
    ).toBe("Deep Dive");

    expect(getPreviousNextFromRuntimeRoutes(routes, "/guide")).toMatchObject({
      previous: { href: "/overview" },
      next: { href: "/advanced" },
    });
  });

  test("returns runtime-source section-root redirects", async () => {
    await expect(
      resolveDocsRouteData(createFakeRuntimeSource(), "/guides")
    ).resolves.toMatchObject({
      type: "redirect",
      href: "/guides/start",
      status: 308,
    });
  });
});

const sections: RuntimeSection[] = [
  { slug: "docs", label: "Docs", default: true },
  { slug: "guides", label: "Guides" },
];

const navigationBySection: Record<string, RuntimeNavNode[]> = {
  docs: [
    { heading: "Start" },
    { title: "Overview Route", href: "/overview" },
    { title: "Guide", href: "/guide" },
    { heading: "Deep Dive" },
    { title: "Advanced", href: "/advanced" },
  ],
  guides: [
    { heading: "Guides" },
    { title: "Guides Start", href: "/guides/start" },
  ],
};

const pages: Record<string, RuntimePage> = {
  "/overview": createPage({
    href: "/overview",
    title: "Overview",
    description: "Start here.",
    keywords: ["intro", "doxa"],
    headings: [{ level: 2, text: "Install", href: "#install" }],
  }),
  "/guide": createPage({ href: "/guide", title: "Guide" }),
  "/advanced": createPage({ href: "/advanced", title: "Advanced" }),
  "/guides/start": createPage({
    href: "/guides/start",
    title: "Guides Start",
    sectionSlug: "guides",
  }),
};

const rawPages: Record<string, RuntimeRawPage> = Object.fromEntries(
  Object.values(pages).map((page) => [
    page.href,
    {
      slug: page.slug,
      href: page.href,
      title: page.title,
      description: page.description,
      sourcePath: page.sourcePath,
      body: `---\ntitle: ${page.title}\n---\n\n# ${page.title}\n\nBody.`,
    },
  ])
);

function findRuntimeElement(
  nodes: readonly RuntimeMdxNode[],
  name: RuntimeMdxElementNode["name"]
): RuntimeMdxElementNode | null {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.name === name) return node;
    const childMatch = findRuntimeElement(node.children ?? [], name);
    if (childMatch) return childMatch;
  }
  return null;
}

function createFakeRuntimeSource(
  overrides: Partial<DoxaDocsRuntimeSource> = {}
): DoxaDocsRuntimeSource {
  const source: DoxaDocsRuntimeSource = {
    async getSiteConfig() {
      return {
        name: "Doxa Test",
        description: "Generated docs.",
        url: "https://docs.example.com/",
      };
    },
    async getCompanyConfig() {
      return { name: "Doxa", link: "https://docs.example.com" };
    },
    async getSocialConfig() {
      return {
        twitterHandle: "",
        openGraph: {
          type: "website",
          title: "Doxa",
          description: "Generated docs.",
          siteName: "Doxa",
          images: [],
        },
        twitter: {
          card: "summary_large_image",
          title: "Doxa",
          description: "Generated docs.",
          site: "",
          images: [],
        },
      };
    },
    async getThemeConfig() {
      return { primaryColor: "default", activeTheme: "default" };
    },
    async getFeatureConfig() {
      return featureConfig;
    },
    async getSections() {
      return sections;
    },
    async getNavigation(sectionSlug) {
      return navigationBySection[sectionSlug] ?? [];
    },
    async getRoutes(sectionSlug) {
      return filterLinkableRuntimePages(navigationBySection[sectionSlug] ?? []);
    },
    async getHomeHref() {
      return "/overview";
    },
    async resolvePage(pathname) {
      const href = normalizeRuntimeHref(pathname);
      const slug = normalizeRuntimeSlug(href);

      if (href === "/") {
        return { type: "redirect", href: "/overview", status: 308 };
      }

      if (slug === "default" || slug.startsWith("default/")) {
        return { type: "not_found", href, slug };
      }

      if (href === "/guides") {
        return { type: "redirect", href: "/guides/start", status: 308 };
      }

      const page = pages[href];
      return page
        ? { type: "page", href, slug, page }
        : { type: "not_found", href, slug };
    },
    async getPage(slugOrHref) {
      return pages[normalizeRuntimeHref(slugOrHref)] ?? null;
    },
    async getRawPage(slugOrHref) {
      return rawPages[normalizeRuntimeHref(slugOrHref)] ?? null;
    },
    async getSearchIndex() {
      return null;
    },
  };

  return { ...source, ...overrides };
}

function createPage({
  href,
  title,
  description = "",
  keywords = [],
  headings = [],
  sectionSlug = "docs",
}: Pick<RuntimePage, "href" | "title"> &
  Partial<
    Pick<RuntimePage, "description" | "keywords" | "headings" | "sectionSlug">
  >): RuntimePage {
  const slug = normalizeRuntimeSlug(href);

  return {
    slug,
    href,
    title,
    description,
    keywords,
    sectionSlug,
    sourcePath: `${slug}/index.mdx`,
    body: `---\ntitle: ${title}\n---\n\n# ${title}`,
    headings,
  };
}

const featureConfig: RuntimeFeatureConfig = {
  branding: true,
  rightSidebar: true,
  feedbackEdit: true,
  tableOfContents: true,
  scrollToTop: true,
  ai: {
    chat: true,
    chatWithPage: true,
    floatingInput: true,
  },
  copyPage: {
    markdown: true,
    rawText: true,
  },
  apiPlayground: true,
  rawMarkdown: true,
  loadFromGithub: false,
};
