import { describe, expect, test } from "vitest"
import type { DocsContentOverviewDto, DocsContentPageDetailDto, DocsContentPageDto } from "@doxahq/contracts"

import type { ContentTreeSection } from "~/lib/dashboard/content-navigation"
import {
  followPageRename,
  pageHrefFromSlug,
  pageSlugError,
  pageSlugTarget,
  renamedPageDetail,
} from "~/lib/dashboard/page-slug"

function page(href: string, title = href): DocsContentPageDto {
  return { href, title, sourcePath: `${href}.mdx`, status: "published", icon: null }
}

function section(slug: string, pages: DocsContentPageDto[], isDefault = false): ContentTreeSection {
  return {
    slug,
    label: slug,
    isDefault,
    editedCount: 0,
    groups: [{ id: `${slug}:0`, heading: null, groupIndex: null, pages, editedCount: 0 }],
  }
}

const tree = [
  section("docs", [page("/"), page("/quickstart", "Quickstart"), page("/guides/setup", "Setup")], true),
  section("api", [page("/api"), page("/api/auth", "Auth")]),
  section("__other", [page("/orphan")]),
]

describe("page slug target", () => {
  test("a page in the default section has no prefix", () => {
    expect(pageSlugTarget(tree, "/quickstart")).toEqual({ prefix: "", slug: "quickstart", title: "Quickstart" })
  })

  test("a nested slug keeps every segment", () => {
    expect(pageSlugTarget(tree, "/guides/setup")).toEqual({ prefix: "", slug: "guides/setup", title: "Setup" })
  })

  test("a page in another section has the section prefix", () => {
    expect(pageSlugTarget(tree, "/api/auth")).toEqual({ prefix: "api", slug: "auth", title: "Auth" })
  })

  test.each([
    ["the site root", "/"],
    ["a section start page", "/api"],
    ["a page outside every section", "/orphan"],
    ["an unknown page", "/missing"],
  ])("%s has no editable slug", (_, href) => {
    expect(pageSlugTarget(tree, href)).toBeNull()
  })

  test("no page selected", () => {
    expect(pageSlugTarget(tree, null)).toBeNull()
  })
})

describe("page href from slug", () => {
  test("joins the prefix and the slug", () => {
    expect(pageHrefFromSlug("api", "tokens")).toBe("/api/tokens")
    expect(pageHrefFromSlug("", " intro ")).toBe("/intro")
  })
})

describe("page slug error", () => {
  test.each(["intro", "getting-started", "guides/setup", "v2"])("accepts %s", (slug) => {
    expect(pageSlugError(slug)).toBeNull()
  })

  test.each(["", "Intro", "two  words", "a--b", "-a", "a/", "/a", "2fa"])("refuses %j", (slug) => {
    expect(pageSlugError(slug)).toMatch(/lowercase letters/)
  })
})

function overview(hrefs: string[]): DocsContentOverviewDto {
  return {
    pages: hrefs.map((href) => page(href)),
    navigation: [{ slug: "docs", label: "Docs", isDefault: true, groups: [{ heading: null, groupIndex: null, hrefs }] }],
    working: { editedHrefs: [] },
  } as unknown as DocsContentOverviewDto
}

describe("follow page rename", () => {
  test("moves the page and its navigation entry to the new href", () => {
    const next = followPageRename(overview(["/", "/guide", "/faq"]), "/guide", "/setup")
    expect(next.pages.map((entry) => [entry.href, entry.status, entry.sourcePath])).toEqual([
      ["/", "published", "/.mdx"],
      ["/setup", "edited", "source/setup/index.mdx"],
      ["/faq", "published", "/faq.mdx"],
    ])
    expect(next.navigation[0].groups[0].hrefs).toEqual(["/", "/setup", "/faq"])
    expect(next.working.editedHrefs).toEqual(["/setup"])
  })

  test("returns the overview unchanged once it lists the new href", () => {
    const confirmed = overview(["/", "/setup"])
    expect(followPageRename(confirmed, "/guide", "/setup")).toBe(confirmed)
  })

  test("returns the overview unchanged when the old href is gone", () => {
    const other = overview(["/", "/faq"])
    expect(followPageRename(other, "/guide", "/setup")).toBe(other)
  })
})

describe("renamed page detail", () => {
  const previous: DocsContentPageDetailDto = {
    href: "/guide",
    title: "Guide",
    sourcePath: "source/guide/index.mdx",
    status: "published",
    publishedContent: "Published body.",
    workingContent: null,
  }

  test("moves the body to the new href as an edit", () => {
    expect(renamedPageDetail(previous, "/setup")).toEqual({
      href: "/setup",
      title: "Guide",
      sourcePath: "source/setup/index.mdx",
      status: "edited",
      publishedContent: "",
      workingContent: "Published body.",
    })
  })

  test("keeps a working body over the published one", () => {
    expect(renamedPageDetail({ ...previous, workingContent: "Working body." }, "/setup").workingContent).toBe(
      "Working body.",
    )
  })
})
