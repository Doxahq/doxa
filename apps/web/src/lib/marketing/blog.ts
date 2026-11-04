import {
  collectFenceLanguages,
  parseRuntimeMdx,
  runtimeMdxHeadings,
  type RuntimeMdxDocument,
  type RuntimeMdxHeading,
} from "@doxahq/mdx-runtime"

import { loadDocsHighlighter } from "~/lib/editor/docs-highlighter"

/**
 * The blog posts: `content/blog/<slug>.mdx`. Only the server functions in
 * `server/blog.ts` import the values of this module, so the post sources stay
 * out of the browser bundle. Components import the types only.
 */

export interface BlogPostMeta {
  slug: string
  title: string
  description: string
  /** `YYYY-MM-DD` */
  date: string
  /** The date as a reader sees it: "November 2, 2026". */
  dateLabel: string
  author: string
  /** The path of a cover image in `public`. Without one, the post has the drawn cover. */
  cover?: string
}

export interface BlogPost extends BlogPostMeta {
  document: RuntimeMdxDocument
  /** The h2 and h3 headings, for the contents list. */
  headings: RuntimeMdxHeading[]
}

const SOURCES = import.meta.glob<string>("../../content/blog/*.mdx", {
  query: "?raw",
  import: "default",
  eager: true,
})

function readFrontmatterBlock(source: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? ""
}

/** A post with `draft: true` in its frontmatter has no page and no card. */
export function isDraftPost(source: string): boolean {
  return /^draft:\s*["']?true["']?\s*$/m.test(readFrontmatterBlock(source))
}

const sourceBySlug = new Map(
  Object.entries(SOURCES)
    .filter(([, source]) => !isDraftPost(source))
    .map(([path, source]) => [path.replace(/^.*\/|\.mdx$/g, ""), source]),
)

/** `readFrontmatter` of the MDX runtime keeps only the docs fields, so it drops `date` and `author`. */
function readOptionalField(source: string, name: string): string | undefined {
  const value = new RegExp(`^${name}:\\s*(.*)$`, "m").exec(readFrontmatterBlock(source))?.[1]?.trim()
  return value?.replace(/^(["'])(.*)\1$/, "$2").replace(/\\"/g, '"')
}

function readField(slug: string, source: string, name: string): string {
  const text = readOptionalField(source, name)
  if (!text) throw new Error(`Blog post "${slug}" has no ${name} in its frontmatter`)
  return text
}

/** Reads the calendar date in UTC, so the label is the same day in every timezone. */
export function formatBlogDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

function readMeta(slug: string, source: string): BlogPostMeta {
  const date = readField(slug, source, "date")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Blog post "${slug}" has a bad date: ${date}`)
  return {
    slug,
    title: readField(slug, source, "title"),
    description: readField(slug, source, "description"),
    date,
    dateLabel: formatBlogDate(date),
    author: readField(slug, source, "author"),
    cover: readOptionalField(source, "cover") || undefined,
  }
}

/** All published posts, newest first. */
export function listBlogPosts(): BlogPostMeta[] {
  return [...sourceBySlug]
    .map(([slug, source]) => readMeta(slug, source))
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug))
}

/** One parsed post with its code highlighted, or null for an unknown slug. */
export async function loadBlogPost(slug: string): Promise<BlogPost | null> {
  const source = sourceBySlug.get(slug)
  if (source === undefined) return null

  const highlighter = await loadDocsHighlighter()
  await highlighter.load(collectFenceLanguages(source))
  const document = parseRuntimeMdx(source, {
    sourceLabel: `blog/${slug}`,
    highlighter: highlighter.parserHighlighter,
  })
  return {
    ...readMeta(slug, source),
    document,
    headings: runtimeMdxHeadings(document.nodes, { minLevel: 2, maxLevel: 3 }),
  }
}
