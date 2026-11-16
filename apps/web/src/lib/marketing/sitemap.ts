import type { BlogPostMeta } from "~/lib/marketing/blog"
import { absoluteUrl } from "~/lib/marketing/links"

/**
 * /sitemap.xml of the marketing site (https://www.sitemaps.org/protocol.html).
 * It lists the pages that belong in search results. Sign-in, the dashboard and
 * the other app pages have `noindex` and stay out.
 */

/** The marketing pages besides the blog posts. A new marketing page goes here too. */
export const SITEMAP_PAGE_PATHS = [
  "/",
  "/agent",
  "/mcp",
  "/pricing",
  "/about",
  "/blog",
  "/legal",
  "/legal/terms",
  "/legal/privacy",
] as const

export interface SitemapEntry {
  url: string
  /** `YYYY-MM-DD`, only when the date of the last change is known. */
  lastModified?: string
}

export function listSitemapEntries(posts: readonly BlogPostMeta[]): SitemapEntry[] {
  return [
    ...SITEMAP_PAGE_PATHS.map((path) => ({ url: absoluteUrl(path) })),
    ...posts.map((post) => ({ url: absoluteUrl(`/blog/${post.slug}`), lastModified: post.date })),
  ]
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function formatEntry(entry: SitemapEntry): string {
  const lastModified = entry.lastModified ? `<lastmod>${entry.lastModified}</lastmod>` : ""
  return `  <url><loc>${escapeXml(entry.url)}</loc>${lastModified}</url>`
}

export function formatSitemap(entries: readonly SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(formatEntry),
    "</urlset>",
    "",
  ].join("\n")
}
