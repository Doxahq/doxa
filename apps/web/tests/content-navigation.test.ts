import { describe, expect, test } from "vitest"
import type {
  DocsContentNavigationSectionDto,
  DocsContentPageDto,
} from "@doxahq/contracts"

import {
  buildContentTree,
  contentHomeHref,
  findPagePath,
  firstChangedHref,
} from "~/lib/dashboard/content-navigation"

const pages: DocsContentPageDto[] = [
  createPage("/guide", "Guide"),
  createPage("/", "Overview", "edited"),
  createPage("/api", "API", "edited"),
  createPage("/orphan", "Orphan"),
]

const navigation: DocsContentNavigationSectionDto[] = [
  {
    slug: "docs",
    label: "Documentation",
    isDefault: true,
    groups: [
      { heading: "Introduction", groupIndex: 0, hrefs: ["/", "/guide"] },
    ],
  },
  {
    slug: "reference",
    label: "API Reference",
    isDefault: false,
    groups: [{ heading: null, groupIndex: null, hrefs: ["/api"] }],
  },
]

describe("buildContentTree", () => {
  test("preserves the published order of sections, groups, and pages", () => {
    const tree = buildContentTree(pages, navigation)

    expect(tree.map((section) => section.slug)).toEqual([
      "docs",
      "reference",
      "__other",
    ])
    expect(tree[0]?.groups[0]?.pages.map((page) => page.href)).toEqual([
      "/",
      "/guide",
    ])
    expect(tree.map((section) => section.isDefault)).toEqual([true, false, false])
  })

  test("adds an orphan section only when navigation leaves pages unplaced", () => {
    const completeNavigation = [
      ...navigation,
      {
        slug: "misc",
        label: "Miscellaneous",
        isDefault: false,
        groups: [{ heading: null, groupIndex: null, hrefs: ["/orphan"] }],
      },
    ]

    expect(buildContentTree(pages, navigation).at(-1)?.slug).toBe("__other")
    expect(buildContentTree(pages, completeNavigation).some(({ slug }) => slug === "__other")).toBe(false)
  })

  test("rolls edited page counts up to groups and sections", () => {
    const tree = buildContentTree(pages, navigation)

    expect(tree[0]?.groups[0]?.editedCount).toBe(1)
    expect(tree[0]?.editedCount).toBe(1)
    expect(tree[1]?.groups[0]?.editedCount).toBe(1)
    expect(tree[1]?.editedCount).toBe(1)
    expect(tree[2]?.editedCount).toBe(0)
  })

  test("keeps group ids unique when one section repeats a heading", () => {
    const tree = buildContentTree(pages, [
      {
        slug: "docs",
        label: "Documentation",
        isDefault: true,
        groups: [
          { heading: "Guides", groupIndex: 0, hrefs: ["/"] },
          { heading: "Reference", groupIndex: 1, hrefs: ["/guide"] },
          { heading: "Guides", groupIndex: 2, hrefs: ["/api"] },
        ],
      },
    ])
    const ids = tree[0]?.groups.map((group) => group.id) ?? []

    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(findPagePath(tree, "/api")?.groupId).toBe(ids[2])
  })

  test("collects every page in one trailing section when navigation is empty", () => {
    const tree = buildContentTree(pages, [])

    expect(tree).toHaveLength(1)
    expect(tree[0]?.slug).toBe("__other")
    expect(tree[0]?.groups[0]?.pages).toEqual(pages)
  })

  test("uses the artifact group index after an empty heading", () => {
    const tree = buildContentTree(pages, [
      {
        slug: "docs",
        label: "Documentation",
        isDefault: true,
        groups: [
          { heading: "Reference", groupIndex: 1, hrefs: ["/"] },
        ],
      },
    ])

    // The index addresses the group on the server. The id only has to stay
    // unique and stable, so it does not carry the index.
    expect(tree[0]?.groups[0]?.groupIndex).toBe(1)
    expect(tree[0]?.groups[0]?.id).toBe("docs:Reference#0")
  })

  test("shows a heading with no page yet as an empty group", () => {
    const tree = buildContentTree(pages, [
      {
        slug: "docs",
        label: "Documentation",
        isDefault: true,
        groups: [
          { heading: "Introduction", groupIndex: 0, hrefs: ["/", "/guide"] },
          { heading: "Recipes", groupIndex: 1, hrefs: [] },
        ],
      },
    ])

    expect(tree[0]?.groups.map((group) => [group.heading, group.groupIndex, group.pages.length])).toEqual([
      ["Introduction", 0, 2],
      ["Recipes", 1, 0],
    ])
  })

  test("drops a group whose pages all sit in an earlier group", () => {
    const tree = buildContentTree(pages, [
      {
        slug: "docs",
        label: "Documentation",
        isDefault: true,
        groups: [
          { heading: "Introduction", groupIndex: 0, hrefs: ["/"] },
          { heading: "Again", groupIndex: 1, hrefs: ["/"] },
          { heading: null, groupIndex: null, hrefs: [] },
        ],
      },
    ])

    expect(tree[0]?.groups.map((group) => group.heading)).toEqual(["Introduction"])
  })

  test("keeps a group id stable when a move renumbers the artifact index", () => {
    const before = buildContentTree(pages, [
      {
        slug: "docs",
        label: "Documentation",
        isDefault: true,
        groups: [
          { heading: "Introduction", groupIndex: 0, hrefs: ["/"] },
          { heading: "Guides", groupIndex: 1, hrefs: ["/guide"] },
        ],
      },
    ])
    const after = buildContentTree(pages, [
      {
        slug: "docs",
        label: "Documentation",
        isDefault: true,
        groups: [
          { heading: "Guides", groupIndex: 0, hrefs: ["/guide"] },
          { heading: "Introduction", groupIndex: 1, hrefs: ["/"] },
        ],
      },
    ])

    // An id built from the index would change here, and the tree would then
    // read the group as a new one and collapse it.
    expect(after[0]?.groups[0]?.id).toBe(before[0]?.groups[1]?.id)
    expect(after[0]?.groups[1]?.id).toBe(before[0]?.groups[0]?.id)
  })
})

describe("findPagePath", () => {
  const tree = buildContentTree(pages, navigation)

  test("finds the section and group that contain a page", () => {
    expect(findPagePath(tree, "/api")).toEqual({
      sectionSlug: "reference",
      groupId: "reference:#0",
    })
  })

  test("returns null for a missing or unselected page", () => {
    expect(findPagePath(tree, "/missing")).toBeNull()
    expect(findPagePath(tree, null)).toBeNull()
  })
})

describe("firstChangedHref", () => {
  test("returns the first edited page in sidebar order", () => {
    // "/api" comes first in the overview, but "/" comes first in the sidebar.
    expect(firstChangedHref([pages[2], ...pages], navigation)).toBe("/")
  })

  test("falls back to an edited page outside the navigation", () => {
    expect(firstChangedHref([createPage("/guide", "Guide"), createPage("/orphan", "Orphan", "edited")], navigation)).toBe("/orphan")
  })

  test("returns null when no page changed", () => {
    expect(firstChangedHref([createPage("/guide", "Guide")], navigation)).toBeNull()
  })
})

describe("contentHomeHref", () => {
  const config = (homePage?: string) => ({ homePage })

  test("is the first page of the default section without a choice", () => {
    expect(contentHomeHref(pages, navigation, { published: config(), working: null })).toBe("/")
    expect(contentHomeHref(pages, navigation, null)).toBe("/")
  })

  test("is the chosen page, and the working config wins over the published one", () => {
    expect(contentHomeHref(pages, navigation, { published: config("/api"), working: null })).toBe("/api")
    expect(
      contentHomeHref(pages, navigation, { published: config("/api"), working: config("/guide") }),
    ).toBe("/guide")
  })

  test("falls back to the first page when the chosen page is gone", () => {
    expect(contentHomeHref(pages, navigation, { published: config("/deleted"), working: null })).toBe("/")
  })

  test("follows a reorder when no page is chosen", () => {
    const reordered = navigation.map((section) =>
      section.isDefault
        ? { ...section, groups: section.groups.map((group) => ({ ...group, hrefs: [...group.hrefs].reverse() })) }
        : section,
    )
    expect(contentHomeHref(pages, reordered, null)).toBe("/guide")
  })
})

function createPage(
  href: string,
  title: string,
  status: DocsContentPageDto["status"] = "published",
): DocsContentPageDto {
  return {
    href,
    title,
    status,
    sourcePath: `source${href === "/" ? "/index" : href}.mdx`,
    icon: null,
  }
}
