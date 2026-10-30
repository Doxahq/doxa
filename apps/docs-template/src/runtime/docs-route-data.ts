import {
  docsAssetNameFromUrlPath,
  docsAssetVersionedUrlPath,
} from "@doxahq/contracts/docs-assets";
import {
  parseRuntimeMdx,
  readFrontmatter,
  runtimeMdxHeadings,
  type RuntimeMdxDocument,
  type RuntimeMdxParseOptions,
} from "@doxahq/mdx-runtime";

import { utf8ByteLength } from "../lib/utf8";
import { loadRouteIcons, type RouteIcons } from "./route-icons";
import {
  filterLinkableRuntimePages,
  flattenRuntimeNavigation,
  getRuntimeSectionFromHref,
  normalizeRuntimeHref,
  normalizeRuntimeSlug,
  type DoxaDocsRuntimeSource,
  type RuntimeFeatureConfig,
  type RuntimeHeading,
  type RuntimeNavNode,
  type RuntimeNavPage,
  type RuntimePage,
  type RuntimeRawPage,
  type RuntimeRouteData,
  type RuntimeRoutePageData,
  type RuntimeSection,
  type RuntimeSiteConfig,
} from "./runtime-source";
import {
  elapsed,
  estimateJsonSize,
  now,
  type RuntimeTimingLogData,
  type RuntimeTimingSink,
} from "./runtime-timing";

type RuntimeRedirectStatus = 301 | 302 | 303 | 307 | 308;

export const RUNTIME_MDX_PARSE_ERROR_CODE = "MDX_RUNTIME_PARSE_FAILED";

export type ParsedDocument =
  | { ok: true; document: RuntimeMdxDocument }
  | {
      ok: false;
      code: typeof RUNTIME_MDX_PARSE_ERROR_CODE;
      error: string;
    };

export interface DocsRouteDocument {
  slug: string;
  href: string;
  sourcePath: string;
  frontmatter: {
    title: string;
    description: string;
    keywords: string;
    apiMethod?: string;
    apiPath?: string;
  };
  tocs: RuntimeHeading[];
  lastUpdated: null;
}

export interface DocsRouteRawDocument {
  body: string;
  title: string;
  description: string;
}

export interface DocsRouteRedirectData {
  type: "redirect";
  href: string;
  status: RuntimeRedirectStatus;
}

export interface DocsRouteRouterNotFoundData {
  type: "router_not_found";
  href: string;
  slug: string;
}

export interface DocsRoutePageData {
  type: "page" | "not_found";
  slug: string;
  href: string;
  homeHref: string | null;
  canonicalUrl: string;
  site: RuntimeSiteConfig;
  features: RuntimeFeatureConfig;
  sections: RuntimeSection[];
  visibleSections: RuntimeSection[];
  currentSection: RuntimeSection | null;
  sectionHomeHrefs: Record<string, string>;
  sectionNavigation: RuntimeNavNode[];
  sectionRoutes: RuntimeNavPage[];
  routeTitle: string | null;
  sectionHeading: string | null;
  previous: RuntimeNavPage | null;
  next: RuntimeNavPage | null;
  document: DocsRouteDocument | null;
  rawDoc: DocsRouteRawDocument | null;
  runtimeDocument: ParsedDocument | null;
  /** Glyphs of the icons this route draws beyond the bundled core set. */
  icons?: RouteIcons;
}

export type DocsRouteData =
  | DocsRouteRedirectData
  | DocsRouteRouterNotFoundData
  | DocsRoutePageData;

export type DocsRootRouteData =
  | DocsRouteData
  | { type: "empty"; homeHref: string | null };

export type DocsParserHighlighter = NonNullable<
  RuntimeMdxParseOptions["highlighter"]
>;

/** Highlights a page with a highlighter that has the page's grammars loaded. */
export interface DocsPageHighlighting {
  parse<T>(
    source: string,
    parse: (highlighter: DocsParserHighlighter) => T
  ): Promise<T>;
}

export interface ResolveDocsRouteDataOptions {
  includeRawDocument?: boolean;
  includeRuntimeDocument?: boolean;
  highlighter?: RuntimeMdxParseOptions["highlighter"];
  /** Wins over `highlighter`. */
  highlighting?: DocsPageHighlighting;
  timing?: RuntimeTimingSink;
}

interface DocsRouteMatchLike {
  loaderData?: unknown;
}

export async function resolveDocsRouteData(
  source: DoxaDocsRuntimeSource,
  pathname: string,
  options: ResolveDocsRouteDataOptions = {}
): Promise<DocsRouteData> {
  const data = await resolveDocsRouteDataWithoutIcons(
    source,
    pathname,
    options
  );
  if (data.type !== "page" && data.type !== "not_found") return data;

  const icons = await measureDocsRouteStep(options.timing, "route.icons", () =>
    loadRouteIcons(data)
  );
  return icons ? { ...data, icons } : data;
}

async function resolveDocsRouteDataWithoutIcons(
  source: DoxaDocsRuntimeSource,
  pathname: string,
  options: ResolveDocsRouteDataOptions
): Promise<DocsRouteData> {
  const startedAt = now();
  const timing = options.timing;
  const includeRawDocument = options.includeRawDocument ?? false;
  const includeRuntimeDocument = options.includeRuntimeDocument ?? false;
  const highlighter = options.highlighter;

  const getRouteData = source.getRouteData;
  if (getRouteData) {
    const runtimeRouteData = await getRuntimeRouteDataIfSupported(
      getRouteData,
      pathname,
      timing
    );

    if (runtimeRouteData) {
      return completeDocsRouteDataFromRuntimeRouteData(
        source,
        runtimeRouteData,
        pathname,
        {
          highlighter,
          highlighting: options.highlighting,
          includeRawDocument,
          includeRuntimeDocument,
          startedAt,
          timing,
        }
      );
    }
  }

  const resolution = await measureDocsRouteStep(
    timing,
    "route.resolvePage",
    () => source.resolvePage(pathname),
    { pathname }
  );

  if (resolution.type === "redirect") {
    timing?.mark("route.complete", {
      pathname,
      type: "redirect",
      durationMs: elapsed(startedAt),
    });
    return {
      type: "redirect",
      href: normalizeRuntimeHref(resolution.href),
      status: resolution.status,
    };
  }

  if (
    resolution.type === "not_found" &&
    isDefaultPrefixedSlug(resolution.slug)
  ) {
    timing?.mark("route.complete", {
      pathname,
      type: "router_not_found",
      durationMs: elapsed(startedAt),
    });
    return {
      type: "router_not_found",
      href: resolution.href,
      slug: resolution.slug,
    };
  }

  const site = await measureDocsRouteStep(timing, "route.getSiteConfig", () =>
    source.getSiteConfig()
  );
  const features = await measureDocsRouteStep(
    timing,
    "route.getFeatureConfig",
    () => source.getFeatureConfig()
  );
  const sections = await measureDocsRouteStep(timing, "route.getSections", () =>
    source.getSections()
  );
  const homeHref = await measureDocsRouteStep(timing, "route.getHomeHref", () =>
    source.getHomeHref()
  );
  const href =
    resolution.type === "page"
      ? normalizeRuntimeHref(resolution.href)
      : normalizeRuntimeHref(resolution.href);
  const slug =
    resolution.type === "page" ? resolution.slug : normalizeRuntimeSlug(href);
  const currentSection = getRuntimeSectionFromHref(sections, href);
  const sectionSlug = currentSection?.slug ?? "";
  const rawSectionNavigation = sectionSlug
    ? await measureDocsRouteStep(
        timing,
        "route.getNavigation",
        () => source.getNavigation(sectionSlug),
        { sectionSlug }
      )
    : [];
  const sectionNavigation = flattenRuntimeNavigation(rawSectionNavigation);
  const sectionRoutes = sectionSlug
    ? await measureDocsRouteStep(
        timing,
        "route.getRoutes",
        () => source.getRoutes(sectionSlug),
        { sectionSlug }
      )
    : [];
  const sectionHomeHrefs = await measureDocsRouteStep(
    timing,
    "route.getSectionHomeHrefs",
    () => getSectionHomeHrefs(source, sections)
  );
  const routeTitle =
    sectionRoutes.find((route) => normalizeRuntimeHref(route.href) === href)
      ?.title ?? null;
  const sectionHeading =
    findSectionHeadingFromRuntimeNavigation(sectionNavigation, href) ?? null;
  const { previous, next } = getPreviousNextFromRuntimeRoutes(
    sectionRoutes,
    href
  );
  const page = resolution.type === "page" ? resolution.page : null;
  const document = page ? toDocsRouteDocument(page) : null;
  const rawDoc =
    page && includeRawDocument && features.copyPage.markdown
      ? await measureDocsRouteStep(
          timing,
          "route.getRawDocument",
          () => getDocsRouteRawDocument(source, page.href),
          { href: page.href }
        )
      : null;
  const runtimeDocument =
    page && (includeRuntimeDocument || isApiReferencePage(page))
      ? await measureDocsRouteStep(
          timing,
          "route.parseRuntimeDocument",
          () => parseDocsRoutePage(page, options, source.cacheScope),
          { sourceBytes: page.body.length }
        )
      : null;

  const routeData: DocsRoutePageData = {
    type: page ? "page" : "not_found",
    slug,
    href,
    homeHref,
    canonicalUrl: getCanonicalUrl(site.url, href),
    site,
    features,
    sections,
    visibleSections: sections.filter((section) => !section.hidden),
    currentSection,
    sectionHomeHrefs,
    sectionNavigation,
    sectionRoutes,
    routeTitle,
    sectionHeading,
    previous,
    next,
    document: withParsedHeadings(document, runtimeDocument),
    rawDoc,
    runtimeDocument,
  };

  timing?.mark("route.complete", {
    pathname,
    type: routeData.type,
    durationMs: elapsed(startedAt),
    sections: sections.length,
    sectionNavigationItems: sectionNavigation.length,
    sectionRoutes: sectionRoutes.length,
    hasRuntimeDocument: runtimeDocument?.ok === true,
    payloadBytes: estimateJsonSize(routeData),
  });

  return routeData;
}

interface CompleteRuntimeRouteDataOptions {
  highlighter?: RuntimeMdxParseOptions["highlighter"];
  highlighting?: DocsPageHighlighting;
  includeRawDocument: boolean;
  includeRuntimeDocument: boolean;
  startedAt: number;
  timing?: RuntimeTimingSink;
}

async function completeDocsRouteDataFromRuntimeRouteData(
  source: DoxaDocsRuntimeSource,
  runtimeRouteData: RuntimeRouteData,
  pathname: string,
  options: CompleteRuntimeRouteDataOptions
): Promise<DocsRouteData> {
  const {
    highlighter,
    highlighting,
    includeRawDocument,
    includeRuntimeDocument,
    startedAt,
    timing,
  } = options;

  if (runtimeRouteData.type === "redirect") {
    timing?.mark("route.complete", {
      pathname,
      type: "redirect",
      durationMs: elapsed(startedAt),
    });
    return {
      type: "redirect",
      href: normalizeRuntimeHref(runtimeRouteData.href),
      status: runtimeRouteData.status,
    };
  }

  if (runtimeRouteData.type === "router_not_found") {
    timing?.mark("route.complete", {
      pathname,
      type: "router_not_found",
      durationMs: elapsed(startedAt),
    });
    return runtimeRouteData;
  }

  const routeData = await buildDocsRoutePageDataFromRuntimeRouteData(
    source,
    runtimeRouteData,
    {
      highlighter,
      highlighting,
      includeRawDocument,
      includeRuntimeDocument,
      timing,
    }
  );

  timing?.mark("route.complete", {
    pathname,
    type: routeData.type,
    durationMs: elapsed(startedAt),
    sections: routeData.sections.length,
    sectionNavigationItems: routeData.sectionNavigation.length,
    sectionRoutes: routeData.sectionRoutes.length,
    hasRuntimeDocument: routeData.runtimeDocument?.ok === true,
    payloadBytes: estimateJsonSize(routeData),
  });

  return routeData;
}

async function buildDocsRoutePageDataFromRuntimeRouteData(
  source: DoxaDocsRuntimeSource,
  runtimeRouteData: RuntimeRoutePageData,
  options: Pick<
    CompleteRuntimeRouteDataOptions,
    | "highlighter"
    | "highlighting"
    | "includeRawDocument"
    | "includeRuntimeDocument"
    | "timing"
  >
): Promise<DocsRoutePageData> {
  const page = runtimeRouteData.page;
  const document = page ? toDocsRouteDocument(page) : null;
  const rawDoc =
    page &&
    options.includeRawDocument &&
    runtimeRouteData.features.copyPage.markdown
      ? await measureDocsRouteStep(
          options.timing,
          "route.getRawDocument",
          () => getDocsRouteRawDocument(source, page.href),
          { href: page.href }
        )
      : null;
  const runtimeDocument =
    page && (options.includeRuntimeDocument || isApiReferencePage(page))
      ? await measureDocsRouteStep(
          options.timing,
          "route.parseRuntimeDocument",
          () => parseDocsRoutePage(page, options, source.cacheScope),
          { sourceBytes: page.body.length }
        )
      : null;

  return {
    type: runtimeRouteData.type,
    slug: runtimeRouteData.slug,
    href: normalizeRuntimeHref(runtimeRouteData.href),
    homeHref: runtimeRouteData.homeHref
      ? normalizeRuntimeHref(runtimeRouteData.homeHref)
      : null,
    canonicalUrl: getCanonicalUrl(
      runtimeRouteData.site.url,
      runtimeRouteData.href
    ),
    site: runtimeRouteData.site,
    features: runtimeRouteData.features,
    sections: runtimeRouteData.sections,
    visibleSections: runtimeRouteData.sections.filter(
      (section) => !section.hidden
    ),
    currentSection: runtimeRouteData.currentSection,
    sectionHomeHrefs: runtimeRouteData.sectionHomeHrefs,
    sectionNavigation: runtimeRouteData.sectionNavigation,
    sectionRoutes: runtimeRouteData.sectionRoutes,
    routeTitle: runtimeRouteData.routeTitle,
    sectionHeading: runtimeRouteData.sectionHeading,
    previous: runtimeRouteData.previous,
    next: runtimeRouteData.next,
    document: withParsedHeadings(document, runtimeDocument),
    rawDoc,
    runtimeDocument,
  };
}

async function getRuntimeRouteDataIfSupported(
  getRouteData: (pathname: string) => Promise<RuntimeRouteData>,
  pathname: string,
  timing: RuntimeTimingSink | undefined
): Promise<RuntimeRouteData | null> {
  try {
    return await measureDocsRouteStep(
      timing,
      "route.getRouteData",
      () => getRouteData(pathname),
      { pathname }
    );
  } catch (error) {
    if (!isUnsupportedRouteDataOperationError(error)) throw error;

    timing?.mark("route.getRouteData.fallback", {
      pathname,
      reason: "unsupported_operation",
    });
    return null;
  }
}

function isUnsupportedRouteDataOperationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();

  return (
    message.includes("invalid_request") ||
    message.includes("expected a runtime operation json body")
  );
}

export async function resolveDocsRootRouteData(
  source: DoxaDocsRuntimeSource,
  options: ResolveDocsRouteDataOptions = {}
): Promise<DocsRootRouteData> {
  const resolution = await resolveDocsRouteData(source, "/", options);

  if (resolution.type === "redirect") {
    const href = normalizeRuntimeHref(resolution.href);
    if (href === "/") {
      return { type: "empty", homeHref: "/" };
    }

    // Older content runtimes can still return the former root redirect. Follow
    // it on the server so the browser receives the home page in one response.
    return resolveDocsRouteData(source, href, options);
  }

  return resolution;
}

async function parseDocsRoutePage(
  page: RuntimePage,
  options: Pick<ResolveDocsRouteDataOptions, "highlighter" | "highlighting">,
  cacheScope?: string
): Promise<ParsedDocument> {
  const bytes = utf8ByteLength(page.body);
  if (bytes > MAX_RENDERED_PAGE_BYTES) {
    logPageTooLarge({ href: page.href, bytes, cacheScope });
    return pageTooLargeDocument(page.body);
  }
  const parse = (highlighter?: DocsParserHighlighter) =>
    parseDocsRouteDocument(page.body, page.href, highlighter, page.assets);
  return options.highlighting
    ? options.highlighting.parse(page.body, parse)
    : parse(options.highlighter);
}

/**
 * Pages above this much MDX render a short notice instead of their content.
 * Not every write path enforces this size, and one renderer isolate serves
 * many sites, so the renderer checks it too.
 */
export const MAX_RENDERED_PAGE_BYTES = 512 * 1024;

const PAGE_TOO_LARGE_NOTICE =
  "> This page is too large to display. Its source is above the 512 KB limit for one page.";

function pageTooLargeDocument(body: string): ParsedDocument {
  return {
    ok: true,
    document: {
      frontmatter: readFrontmatter(body).frontmatter,
      nodes: parseRuntimeMdx(PAGE_TOO_LARGE_NOTICE).nodes,
    },
  };
}

function logPageTooLarge(input: {
  href: string;
  bytes: number;
  cacheScope: string | undefined;
}): void {
  console.warn(
    JSON.stringify({
      event: "docs_page_too_large",
      href: input.href,
      bytes: input.bytes,
      limitBytes: MAX_RENDERED_PAGE_BYTES,
      ...(input.cacheScope ? { scope: input.cacheScope } : {}),
    })
  );
}

export function parseDocsRouteDocument(
  body: string,
  href: string,
  highlighter?: RuntimeMdxParseOptions["highlighter"],
  assets?: RuntimePage["assets"]
): ParsedDocument {
  try {
    return {
      ok: true,
      document: parseRuntimeMdx(body, {
        sourceLabel: href,
        ...(highlighter ? { highlighter } : {}),
        ...(assets ? { resolveAssetUrl: versionedAssetUrl(assets) } : {}),
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[doxa-docs-renderer] Runtime MDX parse failed for ${href}: ${message}`
    );
    return {
      ok: false,
      code: RUNTIME_MDX_PARSE_ERROR_CODE,
      error: message,
    };
  }
}

/**
 * Turns `/assets/{name}` into `/assets/{name}?v={sha256}` for every asset
 * whose hash the content runtime sent. The hash pins the URL to one file, so
 * the browser keeps the image for a year and a new publish gets a new URL.
 */
function versionedAssetUrl(
  assets: NonNullable<RuntimePage["assets"]>
): (url: string) => string {
  return (url) => {
    const name = docsAssetNameFromUrlPath(url);
    const sha256 = name ? assets[name] : undefined;
    if (!name || !sha256) return url;
    try {
      return docsAssetVersionedUrlPath(name, sha256);
    } catch {
      return url;
    }
  };
}

export async function getDocsRouteRawDocument(
  source: Pick<DoxaDocsRuntimeSource, "getRawPage">,
  slugOrHref: string
): Promise<DocsRouteRawDocument | null> {
  try {
    const rawPage = await source.getRawPage(slugOrHref);
    return rawPage ? toCopyPageRawDocument(rawPage) : null;
  } catch {
    return null;
  }
}

export function getDocsRouteDataFromMatches(
  matches: readonly DocsRouteMatchLike[]
): DocsRoutePageData | null {
  for (let index = matches.length - 1; index >= 0; index--) {
    const loaderData = matches[index]?.loaderData;
    if (isDocsRoutePageData(loaderData)) {
      return loaderData;
    }
  }

  return null;
}

export function isDocsRoutePageData(
  value: unknown
): value is DocsRoutePageData {
  if (!value || typeof value !== "object") return false;

  const data = value as Record<string, unknown>;
  return (
    (data.type === "page" || data.type === "not_found") &&
    Array.isArray(data.sectionNavigation) &&
    Array.isArray(data.sectionRoutes) &&
    "currentSection" in data
  );
}

export function findSectionHeadingFromRuntimeNavigation(
  navigation: readonly RuntimeNavNode[],
  href: string
): string | undefined {
  const targetHref = normalizeRuntimeHref(href);
  let currentHeading: string | undefined;

  for (const node of flattenRuntimeNavigation(navigation)) {
    if (isRuntimeNavHeading(node)) {
      currentHeading = node.heading;
    } else if (
      isRuntimeNavPage(node) &&
      normalizeRuntimeHref(node.href) === targetHref
    ) {
      return currentHeading;
    }
  }

  return undefined;
}

export function getPreviousNextFromRuntimeRoutes(
  routes: readonly RuntimeNavPage[],
  href: string
): { previous: RuntimeNavPage | null; next: RuntimeNavPage | null } {
  const targetHref = normalizeRuntimeHref(href);
  const pages = filterLinkableRuntimePages(routes);
  const index = pages.findIndex(
    (route) => normalizeRuntimeHref(route.href) === targetHref
  );

  if (index === -1) {
    return { previous: null, next: null };
  }

  return {
    previous: index > 0 ? pages[index - 1] : null,
    next: index < pages.length - 1 ? pages[index + 1] : null,
  };
}

async function getSectionHomeHrefs(
  source: DoxaDocsRuntimeSource,
  sections: readonly RuntimeSection[]
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    sections
      .filter((section) => !section.hidden)
      .map(async (section) => {
        const routes = await source.getRoutes(section.slug);
        const href = routes[0]?.href;
        return href
          ? ([section.slug, normalizeRuntimeHref(href)] as const)
          : null;
      })
  );

  return Object.fromEntries(entries.filter(isSectionHomeHrefEntry));
}

function isSectionHomeHrefEntry(
  entry: readonly [string, string] | null
): entry is readonly [string, string] {
  return entry !== null;
}

async function measureDocsRouteStep<T>(
  timing: RuntimeTimingSink | undefined,
  event: string,
  operation: () => T | Promise<T>,
  data: RuntimeTimingLogData = {}
): Promise<T> {
  if (!timing?.enabled) return operation();
  return timing.measure(event, operation, data);
}

/**
 * True when the page declares a REST endpoint in its frontmatter.
 *
 * The reference layout in `routes/$.tsx` reads the parsed node tree to split
 * the code samples into the sticky rail and to mount the request playground, so
 * an endpoint page always needs its runtime document. Every other page keeps
 * the compiled-MDX path, which costs no parse at request time.
 */
function isApiReferencePage(page: RuntimePage): boolean {
  return Boolean(page.apiMethod && page.apiPath);
}

function toDocsRouteDocument(page: RuntimePage): DocsRouteDocument {
  return {
    slug: page.slug,
    href: page.href,
    sourcePath: page.sourcePath,
    frontmatter: {
      title: page.title,
      description: page.description,
      keywords: page.keywords.join(", "),
      apiMethod: page.apiMethod,
      apiPath: page.apiPath,
    },
    tocs: page.headings,
    lastUpdated: null,
  };
}

/**
 * The table of contents of a rendered page, read from the parsed document,
 * so its links match the heading anchors that the parser gave the page. The
 * runtime's own heading list stays the fallback for a page without a parsed
 * document.
 */
function withParsedHeadings(
  document: DocsRouteDocument | null,
  runtimeDocument: ParsedDocument | null
): DocsRouteDocument | null {
  if (!document || !runtimeDocument?.ok) return document;
  return {
    ...document,
    tocs: runtimeMdxHeadings(runtimeDocument.document.nodes),
  };
}

function toCopyPageRawDocument(page: RuntimeRawPage): DocsRouteRawDocument {
  return {
    title: page.title,
    description: page.description,
    body: stripFrontmatter(page.body),
  };
}

function stripFrontmatter(source: unknown): string {
  if (typeof source !== "string") return "";
  if (!source.startsWith("---")) return source;

  const match = source.match(/^---(?:\r?\n)[\s\S]*?(?:\r?\n)---(?:\r?\n|$)/);
  return match ? source.slice(match[0].length) : source;
}

function getCanonicalUrl(siteUrl: string, href: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  const normalizedHref = normalizeRuntimeHref(href);
  // The root keeps its slash, as in the sitemap: `https://host/`.
  return `${base}${normalizedHref}`;
}

function isDefaultPrefixedSlug(slug: string): boolean {
  return slug === "default" || slug.startsWith("default/");
}

function isRuntimeNavHeading(
  node: RuntimeNavNode
): node is Extract<RuntimeNavNode, { heading: string }> {
  return "heading" in node && !("title" in node);
}

function isRuntimeNavPage(node: RuntimeNavNode): node is RuntimeNavPage {
  return "title" in node && "href" in node;
}
