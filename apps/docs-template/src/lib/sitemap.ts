/**
 * /sitemap.xml of the requesting site (https://www.sitemaps.org/protocol.html).
 *
 * Every URL uses the request origin, so each hostname of a site lists its own
 * pages, the same URLs that the pages name as canonical. The pages are the
 * linked pages of the visible sections, as in /llms.txt; no page is read.
 */

import { noPublishedDocsResponse } from "@/src/lib/no-published-docs";
import { listSectionRoutes, listVisibleSections } from "@/src/lib/site-routes";
import type { DocsRequestContext } from "@/src/runtime/request-context";
import {
  normalizeRuntimeHref,
  type DoxaDocsRuntimeSource,
} from "@/src/runtime/runtime-source";
import { isNoPublishedDocsError } from "@/src/runtime/runtime-source-error";
import { createConfiguredRuntimeSource } from "@/src/runtime/runtime-source-selection";

/** The protocol limit of URLs in one sitemap file. */
export const SITEMAP_MAX_URLS = 50_000;

const SITEMAP_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
} as const;

/**
 * The absolute page URLs of a site, in navigation order. Only canonical URLs:
 * when the site's home is another page, `/` shows that page and names it as
 * canonical, so `/` itself is left out.
 */
export async function listSitemapUrls(
  source: DoxaDocsRuntimeSource,
  origin: string
): Promise<string[]> {
  const [sections, homeHref] = await Promise.all([
    listVisibleSections(source),
    source.getHomeHref(),
  ]);
  const rootIsDuplicate =
    homeHref !== null && normalizeRuntimeHref(homeHref) !== "/";
  const routes = (await listSectionRoutes(source, sections)).flat();
  return routes
    .filter((route) => !(rootIsDuplicate && route.href === "/"))
    .slice(0, SITEMAP_MAX_URLS)
    .map((route) => new URL(route.href, origin).toString());
}

export function formatSitemap(urls: readonly string[]): string {
  const entries = urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");
}

/** The sitemap of the requesting site. A host without published docs gets a 404. */
export async function createSitemapResponse(
  request: Request,
  context: DocsRequestContext | undefined
): Promise<Response> {
  try {
    const source =
      context?.runtimeSource ?? (await createConfiguredRuntimeSource());
    const urls = await listSitemapUrls(source, new URL(request.url).origin);
    return new Response(formatSitemap(urls), { headers: SITEMAP_HEADERS });
  } catch (error) {
    if (isNoPublishedDocsError(error)) return noPublishedDocsResponse(request);
    throw error;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
