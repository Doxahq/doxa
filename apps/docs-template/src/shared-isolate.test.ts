/**
 * M46 isolation: one renderer isolate serves every site of a build. Each
 * call carries its own site in its entrypoint props, and module state
 * (search engines, icons, theme CSS, highlighter) lives across calls.
 *
 * These tests drive the platform server entry (`server.fetch` and the
 * `DocsPrerenderRenderer` entrypoint) with two sites whose content has unique
 * markers, interleaved at random, and check that no response carries the
 * other site's markers.
 *
 * TanStack Start's request handler needs the Start Vite plugin's virtual
 * modules, which vitest does not load. `startRoutes` stands in for it: it
 * maps each URL to the same handler the app route uses (search, llms, route
 * data) and draws the HTML from the route data, the site config and the
 * shared components. The URL-to-route step has no per-site state.
 */
import { createElement, Fragment } from "react";
import { compileSearchArtifact } from "@doxahq/docs-search";
import { runtimeSearchArtifactSchema } from "@doxahq/docs-search/contracts";
import {
  hashSiteConfig,
  resolveSiteConfig,
  type ResolvedSiteConfig,
} from "@doxahq/site-config";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { BindingRuntimeResolution } from "./runtime/binding-runtime-source";
import type { DocsRequestContext } from "./runtime/request-context";
import type {
  RuntimeFeatureConfig,
  RuntimeNavPage,
  RuntimePage,
  RuntimeRawPage,
  RuntimeRoutePageData,
  RuntimeSection,
} from "./runtime/runtime-source";

const start = vi.hoisted(() => ({
  handler: (
    _request: Request,
    _options: { context: DocsRequestContext }
  ): Promise<Response> => Promise.reject(new Error("not installed")),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown
    ) {}
  },
}));

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler:
    () => (request: Request, options: { context: DocsRequestContext }) =>
      start.handler(request, options),
  defaultStreamHandler: vi.fn(),
  getRequestHost: () => {
    throw new Error("The shared renderer never resolves by request host.");
  },
}));

const { default: server, DocsPrerenderRenderer } = await import("./server");
const { createSearchResponse } = await import("./routes/api.search");
const llms = await import("./lib/llms");
const { resolveDocsRouteData } = await import("./runtime/docs-route-data");
const { loadServerPageHighlighting } =
  await import("./runtime/server-highlighter");
const { loadSiteConfig } = await import("./site-config/load-site-config");
const { RuntimeMdxContent } = await import("./runtime/runtime-mdx-content");
const { DocsIcon, resolveDocsIcon } = await import("./components/docs-icon");
const { ThemeStyle } = await import("./site-config/theme-style");

// ---------------------------------------------------------------------------
// Two fake sites. Every visible field carries the site's marker.

interface FakeSite {
  siteId: string;
  marker: string;
  hostname: string;
  primary: string;
  /** A bundled icon, drawn in the HTML. */
  coreIcon: string;
  /** An icon outside the bundle, sent in the route data. */
  routeIcon: string;
}

const ALPHA: FakeSite = {
  siteId: "site-alpha",
  marker: "QQALPHAQQ",
  hostname: "alpha.doxa.page",
  primary: "#a1a2a3",
  coreIcon: "rocket",
  routeIcon: "atom",
};

const BRAVO: FakeSite = {
  siteId: "site-bravo",
  marker: "QQBRAVOQQ",
  hostname: "bravo.doxa.page",
  primary: "#b1b2b3",
  coreIcon: "database",
  routeIcon: "bird",
};

const SITES = [ALPHA, BRAVO] as const;

/** The same content version for both, as two sites may well have. */
const SHARED_CONTENT_VERSION = "content-v1";

const FEATURES: RuntimeFeatureConfig = {
  branding: true,
  rightSidebar: true,
  feedbackEdit: false,
  tableOfContents: true,
  scrollToTop: true,
  ai: { chat: false, chatWithPage: false, floatingInput: false },
  copyPage: { markdown: true, rawText: true },
  apiPlayground: false,
  rawMarkdown: true,
  loadFromGithub: false,
};

function resolutionFor(site: FakeSite): BindingRuntimeResolution {
  return {
    siteId: site.siteId,
    projectId: `project-${site.siteId}`,
    projectSlug: site.siteId,
    publishedVersionId: `version-${site.siteId}`,
    artifactPrefix: `sites/${site.siteId}/versions/v1`,
    manifestPath: `sites/${site.siteId}/versions/v1/manifest.json`,
    accessPolicy: "public",
  };
}

function siteConfigFor(site: FakeSite): ResolvedSiteConfig {
  return resolveSiteConfig({
    name: `Docs ${site.marker}`,
    description: `About ${site.marker}`,
    theme: { primary: site.primary },
  });
}

function pageBody(site: FakeSite): string {
  return [
    "---",
    `title: Guide ${site.marker}`,
    "---",
    "",
    `# Guide ${site.marker}`,
    "",
    `The ${site.marker} body text.`,
    "",
    "```ts",
    `const site = "${site.marker}";`,
    "```",
  ].join("\n");
}

function sectionFor(site: FakeSite): RuntimeSection {
  return { slug: "docs", label: `Section ${site.marker}`, default: true };
}

function navigationFor(site: FakeSite): RuntimeNavPage[] {
  return [
    { title: `Guide ${site.marker}`, href: "/guide", icon: site.coreIcon },
    { title: `Icons ${site.marker}`, href: "/icons", icon: site.routeIcon },
  ];
}

function pageFor(site: FakeSite): RuntimePage {
  return {
    slug: "guide",
    href: "/guide",
    title: `Guide ${site.marker}`,
    description: `Guide for ${site.marker}`,
    keywords: [],
    sectionSlug: "docs",
    sourcePath: "guide/index.mdx",
    body: pageBody(site),
    headings: [],
  };
}

function rawPageFor(site: FakeSite, href: string): RuntimeRawPage | null {
  if (href !== "/guide" && href !== "guide") return null;
  const page = pageFor(site);
  return {
    slug: page.slug,
    href: page.href,
    title: page.title,
    description: page.description,
    sourcePath: page.sourcePath,
    body: page.body,
  };
}

function routeDataFor(site: FakeSite, pathname: string): RuntimeRoutePageData {
  const section = sectionFor(site);
  const navigation = navigationFor(site);
  const page = pathname === "/guide" ? pageFor(site) : null;
  return {
    siteConfig: siteConfigFor(site),
    type: page ? "page" : "not_found",
    slug: pathname.slice(1),
    href: pathname,
    homeHref: "/guide",
    site: {
      name: `Docs ${site.marker}`,
      description: `About ${site.marker}`,
      url: `https://${site.hostname}`,
    },
    features: FEATURES,
    sections: [section],
    currentSection: section,
    sectionHomeHrefs: { docs: "/guide" },
    sectionNavigation: navigation,
    sectionRoutes: navigation,
    routeTitle: page ? page.title : null,
    sectionHeading: null,
    previous: null,
    next: null,
    page,
  };
}

function compiledSearchIndexFor(site: FakeSite): string {
  const artifact = runtimeSearchArtifactSchema.parse({
    schemaVersion: 1,
    contentVersion: SHARED_CONTENT_VERSION,
    documents: [
      {
        id: "/guide",
        slug: "/guide",
        title: `Guide ${site.marker}`,
        description: "",
        breadcrumb: [],
        section: "docs",
        headings: [],
        keywords: [],
        content: `Shared search term and ${site.marker}`,
        lines: [{ text: `Shared search term and ${site.marker}` }],
      },
    ],
  });
  return JSON.stringify(compileSearchArtifact(artifact));
}

// ---------------------------------------------------------------------------
// The content binding the dispatcher pins to one site, with random delays.

interface BindingCall {
  boundSiteId: string;
  requestedSiteId: string | undefined;
}

const bindingCalls: BindingCall[] = [];

const randomDelay = () =>
  new Promise((resolve) => setTimeout(resolve, Math.random() * 4));

function readRequestedSiteId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const resolution: unknown = Reflect.get(input, "resolution");
  if (typeof resolution !== "object" || resolution === null) return undefined;
  const siteId: unknown = Reflect.get(resolution, "siteId");
  return typeof siteId === "string" ? siteId : undefined;
}

function readPayloadString(input: unknown, field: string): string {
  if (typeof input !== "object" || input === null) return "";
  const payload: unknown = Reflect.get(input, "payload");
  if (typeof payload !== "object" || payload === null) return "";
  const value: unknown = Reflect.get(payload, field);
  return typeof value === "string" ? value : "";
}

function readOperation(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const operation: unknown = Reflect.get(input, "operation");
  return typeof operation === "string" ? operation : "";
}

function answer(site: FakeSite, input: unknown): unknown {
  switch (readOperation(input)) {
    case "getRouteData":
      return routeDataFor(site, readPayloadString(input, "pathname"));
    case "getResolvedSiteConfig":
      return siteConfigFor(site);
    case "getFeatureConfig":
      return FEATURES;
    case "getSections":
      return [sectionFor(site)];
    case "getRoutes":
    case "getNavigation":
      return navigationFor(site);
    case "getRawPage":
      return rawPageFor(site, readPayloadString(input, "slug"));
    case "getCompiledSearchIndex":
      return compiledSearchIndexFor(site);
    case "getSearchIndex":
      return null;
    default:
      throw new Error(`The fake binding has no ${readOperation(input)}.`);
  }
}

function contentBindingFor(site: FakeSite) {
  return {
    async request(input: unknown) {
      bindingCalls.push({
        boundSiteId: site.siteId,
        requestedSiteId: readRequestedSiteId(input),
      });
      await randomDelay();
      return { ok: true as const, data: answer(site, input) };
    },
  };
}

/** Entrypoint props of one call, as the dispatcher sends them. */
function propsFor(site: FakeSite) {
  return { content: contentBindingFor(site), resolution: resolutionFor(site) };
}

/** The execution context of one renderer call, with its entrypoint props. */
function executionContext(props: unknown): ExecutionContext {
  return {
    props,
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}

/** The `build` isolate's env: binding mode and no site of its own. */
const BUILD_ISOLATE_ENV = { DOXA_DOCS_RUNTIME_SOURCE: "binding" };

// ---------------------------------------------------------------------------
// The stand-in for TanStack Start's handler.

async function startRoutes(
  request: Request,
  { context }: { context: DocsRequestContext }
): Promise<Response> {
  const source = context.runtimeSource;
  if (!source) throw new Error("Every shared-isolate call has a source.");
  const url = new URL(request.url);

  switch (url.pathname) {
    case "/api/search":
      return createSearchResponse(request, source);
    case "/llms.txt":
      return llms.createLlmsResponse(
        request,
        context,
        llms.formatLlmsIndex,
        llms.LLMS_INDEX_LOAD_OPTIONS
      );
    case "/llms-full.txt":
      return llms.createLlmsResponse(
        request,
        context,
        llms.formatLlmsFull,
        llms.LLMS_FULL_LOAD_OPTIONS
      );
  }

  // `/_serverFn/{id}` is `loadDocsRouteData`; the test passes its pathname.
  const pathname = url.pathname.startsWith("/_serverFn/")
    ? (url.searchParams.get("pathname") ?? "/")
    : url.pathname;
  const routeData =
    context.preparedRoute?.pathname === pathname
      ? context.preparedRoute.data
      : await resolveDocsRouteData(source, pathname, {
          includeRuntimeDocument: true,
          highlighting: await loadServerPageHighlighting(),
        });
  if (url.pathname.startsWith("/_serverFn/")) return Response.json(routeData);

  const config = context.siteConfig ?? (await loadSiteConfig(source));
  return new Response(
    await renderDocument(config, routeData, await hashSiteConfig(config)),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function renderDocument(
  config: ResolvedSiteConfig,
  routeData: unknown,
  configHash: string
): Promise<string> {
  const navigation = isPageRouteData(routeData)
    ? routeData.sectionNavigation
    : [];
  const icons = navigation.flatMap((node) => {
    const icon = node.icon ? resolveDocsIcon(node.icon) : null;
    return icon ? [createElement(icon, { key: node.href })] : [];
  });
  const body =
    isPageRouteData(routeData) && routeData.runtimeDocument?.ok
      ? createElement(RuntimeMdxContent, {
          document: routeData.runtimeDocument.document,
        })
      : null;
  return renderToStaticMarkup(
    createElement(
      "html",
      null,
      createElement(
        "head",
        null,
        createElement(ThemeStyle, { theme: config.theme, configHash })
      ),
      createElement(
        "body",
        null,
        createElement("h1", null, config.name),
        createElement(Fragment, null, ...icons),
        body,
        createElement("script", {
          dangerouslySetInnerHTML: { __html: JSON.stringify(routeData) },
        })
      )
    )
  );
}

interface PageRouteDataLike {
  sectionNavigation: RuntimeNavPage[];
  runtimeDocument: {
    ok: boolean;
    document: Parameters<typeof RuntimeMdxContent>[0]["document"];
  } | null;
}

function isPageRouteData(value: unknown): value is PageRouteDataLike {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(Reflect.get(value, "sectionNavigation"))
  );
}

// ---------------------------------------------------------------------------

/** Strings that only this site's responses may contain. */
function markersOf(site: FakeSite): string[] {
  return [
    site.marker,
    site.primary,
    `"${site.routeIcon}":[`,
    renderToStaticMarkup(createElement(DocsIcon, { name: site.coreIcon })),
  ];
}

beforeEach(() => {
  start.handler = startRoutes;
  bindingCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

type CallKind =
  | "html"
  | "serverFn"
  | "llms"
  | "llmsFull"
  | "markdown"
  | "search"
  | "prepare"
  | "render";

const CALL_KINDS: readonly CallKind[] = [
  "html",
  "serverFn",
  "llms",
  "llmsFull",
  "markdown",
  "search",
  "prepare",
  "render",
];

async function call(site: FakeSite, kind: CallKind): Promise<string> {
  const ctx = executionContext(propsFor(site));
  const origin = `https://${site.hostname}`;
  const fetchText = async (path: string, accept = "*/*") => {
    const response = await server.fetch(
      new Request(`${origin}${path}`, { headers: { accept } }),
      BUILD_ISOLATE_ENV,
      ctx
    );
    expect(response.status).toBe(200);
    return response.text();
  };
  const renderer = () => new DocsPrerenderRenderer(ctx, BUILD_ISOLATE_ENV);

  switch (kind) {
    case "html":
      return fetchText("/guide", "text/html");
    case "serverFn":
      return fetchText("/_serverFn/route-data?pathname=%2Fguide");
    case "llms":
      return fetchText("/llms.txt");
    case "llmsFull":
      return fetchText("/llms-full.txt");
    case "markdown":
      return fetchText("/guide.md");
    case "search":
      return fetchText("/api/search?q=shared%20search&limit=8");
    case "prepare":
      return JSON.stringify(await renderer().prepare({ pathname: "/guide" }));
    case "render": {
      const routeData = await renderer().prepare({ pathname: "/guide" });
      const response = await renderer().render({
        pathname: "/guide",
        requestUrl: `${origin}/guide`,
        renderId: "a".repeat(64),
        routeData,
      });
      return response.text();
    }
  }
}

describe("shared renderer isolate (M46)", () => {
  test("interleaved calls of two sites never carry the other site's content", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const jobs = Array.from({ length: 64 }, (_, index) => ({
      site: SITES[index % 2],
      kind: CALL_KINDS[Math.floor(index / 2) % CALL_KINDS.length],
    }));
    // Random order, so each kind meets the other site's calls of every kind.
    jobs.sort(() => Math.random() - 0.5);

    const outputs = await Promise.all(
      jobs.map(async (job) => ({
        ...job,
        text: await call(job.site, job.kind),
      }))
    );

    for (const { site, kind, text } of outputs) {
      const other = site === ALPHA ? BRAVO : ALPHA;
      expect(text, `${kind} of ${site.siteId}`).toContain(site.marker);
      for (const marker of markersOf(other)) {
        expect(text, `${kind} of ${site.siteId}`).not.toContain(marker);
      }
    }
    expect(new Set(outputs.map((output) => output.kind))).toEqual(
      new Set(CALL_KINDS)
    );
    for (const bindingCall of bindingCalls) {
      expect(bindingCall.requestedSiteId).toBe(bindingCall.boundSiteId);
    }
  });

  test("each site's HTML carries its own theme colour and icons", async () => {
    for (const site of SITES) {
      const html = await call(site, "html");
      for (const marker of markersOf(site)) expect(html).toContain(marker);
    }
  });

  test("search keeps one engine per site for the same content version", async () => {
    const [alpha, bravo] = await Promise.all([
      call(ALPHA, "search"),
      call(BRAVO, "search"),
    ]);
    expect(alpha).toContain(ALPHA.marker);
    expect(bravo).toContain(BRAVO.marker);
    // Warm engines: the second round reads the cache.
    expect(await call(BRAVO, "search")).not.toContain(ALPHA.marker);
    expect(await call(ALPHA, "search")).not.toContain(BRAVO.marker);
  });
});

describe("missing request scope in the build isolate (F35)", () => {
  test.each([
    { label: "no props", props: undefined },
    { label: "empty props", props: {} },
    {
      label: "a resolution without a content binding",
      props: { resolution: resolutionFor(ALPHA) },
    },
    {
      label: "a binding without a valid resolution",
      props: {
        content: contentBindingFor(ALPHA),
        resolution: { ...resolutionFor(ALPHA), siteId: "" },
      },
    },
  ])("fetch with $label answers a 5xx with no content", async ({ props }) => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await server.fetch(
      new Request(`https://${ALPHA.hostname}/guide`, {
        headers: { accept: "text/html" },
      }),
      BUILD_ISOLATE_ENV,
      executionContext(props)
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-doxa-renderer-error")).toBe(
      "renderer_props_missing"
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    for (const site of SITES) expect(text).not.toContain(site.marker);
    expect(bindingCalls).toHaveLength(0);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "renderer_props_missing",
      entrypoint: "fetch",
    });
  });

  test("the pre-render entrypoint rejects with the code in its message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const renderer = new DocsPrerenderRenderer(
      executionContext(undefined),
      BUILD_ISOLATE_ENV
    );

    await expect(renderer.prepare({ pathname: "/guide" })).rejects.toThrow(
      "[renderer_props_missing]"
    );
    expect(bindingCalls).toHaveLength(0);
  });

  test("the hostname never replaces missing props", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await server.fetch(
      new Request(`https://${ALPHA.hostname}/llms.txt`),
      { ...BUILD_ISOLATE_ENV },
      executionContext(null)
    );
    expect(response.status).toBe(500);
  });
});
