import { readdirSync, readFileSync, statSync } from "node:fs"
import { describe, expect, it } from "vitest"

import type { BlogPostMeta } from "~/lib/marketing/blog"
import { blogPostHead } from "~/lib/marketing/blog-seo"
import { DEFAULT_SOCIAL_IMAGE, marketingHead } from "~/lib/marketing/seo"
import { formatSitemap, listSitemapEntries, SITEMAP_PAGE_PATHS } from "~/lib/marketing/sitemap"
import { jsonLdScript, organizationJsonLd } from "~/lib/marketing/structured-data"

type Head = ReturnType<typeof marketingHead>

function metaContent(head: Head, key: string): string | undefined {
  const tag = head.meta.find(
    (entry) => ("name" in entry && entry.name === key) || ("property" in entry && entry.property === key),
  )
  return tag && "content" in tag ? tag.content : undefined
}

const POST: BlogPostMeta = {
  slug: "a-post",
  title: "A post",
  description: "What the post is about.",
  date: "2026-10-27",
  dateLabel: "October 27, 2026",
  author: "Doxa Team",
}

describe("marketingHead", () => {
  const head = marketingHead({ path: "/pricing", title: "Pricing — Doxa", description: "Plans." })

  it("names the canonical URL and the Open Graph URL on doxa.so", () => {
    expect(head.links).toEqual([{ rel: "canonical", href: "https://doxa.so/pricing" }])
    expect(metaContent(head, "og:url")).toBe("https://doxa.so/pricing")
  })

  it("gives every page a large share card with the default image", () => {
    expect(metaContent(head, "og:type")).toBe("website")
    expect(metaContent(head, "og:title")).toBe("Pricing — Doxa")
    expect(metaContent(head, "twitter:card")).toBe("summary_large_image")
    expect(metaContent(head, "og:image")).toBe(`https://doxa.so${DEFAULT_SOCIAL_IMAGE.path}`)
    expect(metaContent(head, "og:image:width")).toBe("1200")
    expect(metaContent(head, "twitter:image")).toBe(`https://doxa.so${DEFAULT_SOCIAL_IMAGE.path}`)
  })

  it("has the default share image in public", () => {
    const file = new URL(`../public${DEFAULT_SOCIAL_IMAGE.path}`, import.meta.url)
    expect(statSync(file).size).toBeGreaterThan(0)
  })
})

describe("blogPostHead", () => {
  it("shares the cover of a post that has one, as an article", () => {
    const head = blogPostHead({ ...POST, cover: "/marketing/blog/cover.jpg" })
    expect(metaContent(head, "og:type")).toBe("article")
    expect(metaContent(head, "og:image")).toBe("https://doxa.so/marketing/blog/cover.jpg")
    expect(metaContent(head, "og:image:width")).toBeUndefined()
    expect(metaContent(head, "article:published_time")).toBe("2026-10-27")
  })

  it("shares the default image for a post with the drawn cover", () => {
    expect(metaContent(blogPostHead(POST), "og:image")).toBe(`https://doxa.so${DEFAULT_SOCIAL_IMAGE.path}`)
  })

  it("adds BlogPosting structured data", () => {
    const [script] = blogPostHead(POST).scripts
    const data = JSON.parse(script?.children ?? "{}")
    expect(data).toMatchObject({
      "@type": "BlogPosting",
      headline: "A post",
      datePublished: "2026-10-27",
      url: "https://doxa.so/blog/a-post",
    })
  })
})

describe("jsonLdScript", () => {
  it("escapes `<`, so a value cannot close the script tag", () => {
    const script = jsonLdScript({ ...organizationJsonLd(), name: "</script><script>alert(1)" })
    expect(script.type).toBe("application/ld+json")
    expect(script.children).not.toContain("<")
    expect(JSON.parse(script.children).name).toBe("</script><script>alert(1)")
  })
})

/** The URL path of each marketing page file, such as `legal/index.tsx` → `/legal`. */
function marketingRoutePaths(dir: URL, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const child = new URL(name, dir)
    if (statSync(child).isDirectory()) return marketingRoutePaths(new URL(`${name}/`, dir), `${prefix}/${name}`)
    if (name === "route.tsx" || name.includes("$")) return []
    const page = name.replace(/\.tsx$/, "")
    return [page === "index" ? prefix || "/" : `${prefix}/${page}`]
  })
}

describe("sitemap", () => {
  it("lists every marketing page", () => {
    const routes = marketingRoutePaths(new URL("../src/routes/_marketing/", import.meta.url))
    expect([...SITEMAP_PAGE_PATHS].sort()).toEqual(routes.sort())
  })

  it("adds each blog post with its date", () => {
    const xml = formatSitemap(listSitemapEntries([POST]))
    expect(xml).toContain("<url><loc>https://doxa.so/</loc></url>")
    expect(xml).toContain("<url><loc>https://doxa.so/blog/a-post</loc><lastmod>2026-10-27</lastmod></url>")
  })

  it("is named in robots.txt", () => {
    const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8")
    expect(robots).toContain("Sitemap: https://doxa.so/sitemap.xml")
    expect(robots).toMatch(/^User-agent: \*\nAllow: \/$/m)
  })
})
