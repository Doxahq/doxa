import { describe, expect, test } from "vitest"
import type {
  DocsContentOverviewDto,
  DocsContentPageDto,
} from "@doxahq/contracts"

import { overviewSiteSettings } from "./fixtures/site-settings"

import {
  applyOptimisticMove,
  destinationExpandIds,
  flattenContentTree,
  groupContainerId,
  keyboardMoveTarget,
  movesAcrossSections,
  planContentDrop,
  pointerTarget,
  resolveContentDrop,
  resolveDropIndicator,
  rootContainerId,
  sectionContainerId,
  springOpenTarget,
} from "~/lib/dashboard/content-drag"
import type {
  ContentTreeGroup,
  ContentTreeSection,
} from "~/lib/dashboard/content-navigation"

const tree: ContentTreeSection[] = [
  section("docs", "Documentation", [
    group("docs:0:Introduction", 0, "Introduction", ["/", "/guide", "/install"]),
    group("docs:1:Advanced", 1, "Advanced", ["/advanced"]),
  ]),
  section("api", "API", [group("api:0:Endpoints", 0, "Endpoints", ["/api/list"])]),
]

/** Everything open, which is what the tree renders after a page is selected. */
const allOpen = new Set([
  "docs",
  "api",
  "docs:0:Introduction",
  "docs:1:Advanced",
  "api:0:Endpoints",
])

describe("flattenContentTree", () => {
  test("lists every visible row in display order", () => {
    expect(
      flattenContentTree(tree, allOpen).map(({ id, containerId, depth }) => ({
        id,
        containerId,
        depth,
      })),
    ).toEqual([
      { id: "section:docs", containerId: rootContainerId(), depth: 0 },
      {
        id: "group:docs:0:Introduction",
        containerId: sectionContainerId("docs"),
        depth: 1,
      },
      { id: "page:/", containerId: groupContainerId("docs:0:Introduction"), depth: 2 },
      { id: "page:/guide", containerId: groupContainerId("docs:0:Introduction"), depth: 2 },
      { id: "page:/install", containerId: groupContainerId("docs:0:Introduction"), depth: 2 },
      {
        id: "group:docs:1:Advanced",
        containerId: sectionContainerId("docs"),
        depth: 1,
      },
      { id: "page:/advanced", containerId: groupContainerId("docs:1:Advanced"), depth: 2 },
      { id: "section:api", containerId: rootContainerId(), depth: 0 },
      {
        id: "group:api:0:Endpoints",
        containerId: sectionContainerId("api"),
        depth: 1,
      },
      { id: "page:/api/list", containerId: groupContainerId("api:0:Endpoints"), depth: 2 },
    ])
  })

  test("omits the rows of a collapsed branch", () => {
    // A hidden row has no layout box, so a collision test would place it at the
    // origin and win drops the user never aimed at.
    const rows = flattenContentTree(tree, new Set(["docs"]))

    expect(rows.map((row) => row.id)).toEqual([
      "section:docs",
      "group:docs:0:Introduction",
      "group:docs:1:Advanced",
      "section:api",
    ])
  })

  test("lets an unplaced page move out, and refuses drops into its section", () => {
    const orphan = [section("__other", "Other", [group("__other:0:", null, null, ["/loose"])])]
    const rows = flattenContentTree(orphan, new Set(["__other"]))

    expect(rows[0]).toMatchObject({ kind: "section", canDrag: false, canDrop: false })
    expect(rows[1]).toMatchObject({ kind: "page", canDrag: true, canDrop: false })
  })
})

describe("moving a page", () => {
  const rows = flattenContentTree(tree, allOpen)

  test("lands after the target when the pointer is over its lower half", () => {
    expect(resolveContentDrop(rows, "page:/", "page:/guide", "after")).toEqual({
      type: "move_page",
      href: "/",
      toSectionSlug: "docs",
      toGroupIndex: 0,
      beforeHref: "/install",
    })
    // The line marks the place the page lands: under the target.
    expect(resolveDropIndicator(rows, "page:/", "page:/guide", "after")).toEqual({
      rowId: "page:/guide",
      edge: "bottom",
      depth: 2,
    })
  })

  test("lands before the target when the pointer is over its upper half", () => {
    expect(resolveContentDrop(rows, "page:/", "page:/install", "before")).toEqual({
      type: "move_page",
      href: "/",
      toSectionSlug: "docs",
      toGroupIndex: 0,
      beforeHref: "/install",
    })
    expect(resolveDropIndicator(rows, "page:/", "page:/install", "before")).toEqual({
      rowId: "page:/install",
      edge: "top",
      depth: 2,
    })
  })

  test("appends when it lands after the last page of a group", () => {
    expect(resolveContentDrop(rows, "page:/", "page:/install", "after")).toEqual({
      type: "move_page",
      href: "/",
      toSectionSlug: "docs",
      toGroupIndex: 0,
      beforeHref: null,
    })
  })

  test("the side counts in either direction", () => {
    // Moving up, the lower half of a target still means after it.
    expect(resolveContentDrop(rows, "page:/install", "page:/", "after")).toEqual({
      type: "move_page",
      href: "/install",
      toSectionSlug: "docs",
      toGroupIndex: 0,
      beforeHref: "/guide",
    })
    expect(resolveContentDrop(rows, "page:/install", "page:/guide", "before")).toEqual({
      type: "move_page",
      href: "/install",
      toSectionSlug: "docs",
      toGroupIndex: 0,
      beforeHref: "/guide",
    })
  })

  test("a drop that leaves the page in its place moves nothing and shows no line", () => {
    // Just under the page before it, or just over the page after it, is where it already is.
    expect(planContentDrop(rows, "page:/guide", "page:/", "after")).toEqual({ edit: null, indicator: null })
    expect(planContentDrop(rows, "page:/guide", "page:/install", "before")).toEqual({ edit: null, indicator: null })
    expect(planContentDrop(rows, "page:/guide", "page:/guide", "before")).toEqual({ edit: null, indicator: null })
  })

  test("joins the group it is dropped on, at the top", () => {
    expect(resolveContentDrop(rows, "page:/", "group:docs:1:Advanced", "after")).toEqual({
      type: "move_page",
      href: "/",
      toSectionSlug: "docs",
      toGroupIndex: 1,
      beforeHref: "/advanced",
    })
    expect(resolveDropIndicator(rows, "page:/", "group:docs:1:Advanced", "before")).toEqual({
      rowId: "group:docs:1:Advanced",
      edge: "bottom",
      depth: 2,
    })
  })

  test("joins another section when it is dropped on the section header", () => {
    expect(resolveContentDrop(rows, "page:/guide", "section:api", "after")).toEqual({
      type: "move_page",
      href: "/guide",
      toSectionSlug: "api",
      toGroupIndex: null,
      beforeHref: null,
    })
    // The API section has no ungrouped page, so the line sits under its header,
    // at the depth of an ungrouped page.
    expect(resolveDropIndicator(rows, "page:/guide", "section:api", "after")).toEqual({
      rowId: "section:api",
      edge: "bottom",
      depth: 1,
    })
  })
})

describe("moving a group", () => {
  const rows = flattenContentTree(tree, allOpen)

  test("lands after the target group, below its last page", () => {
    expect(resolveContentDrop(rows, "group:docs:0:Introduction", "group:docs:1:Advanced", "after")).toEqual({
      type: "move_group",
      sectionSlug: "docs",
      groupIndex: 0,
      toSectionSlug: "docs",
      beforeGroupIndex: null,
    })
    expect(resolveDropIndicator(rows, "group:docs:0:Introduction", "group:docs:1:Advanced", "after")).toEqual({
      rowId: "page:/advanced",
      edge: "bottom",
      depth: 1,
    })
  })

  test("lands before the target group", () => {
    expect(resolveContentDrop(rows, "group:docs:1:Advanced", "group:docs:0:Introduction", "before")).toEqual({
      type: "move_group",
      sectionSlug: "docs",
      groupIndex: 1,
      toSectionSlug: "docs",
      beforeGroupIndex: 0,
    })
    expect(resolveDropIndicator(rows, "group:docs:1:Advanced", "group:docs:0:Introduction", "before")).toEqual({
      rowId: "group:docs:0:Introduction",
      edge: "top",
      depth: 1,
    })
  })

  test("moves into another section", () => {
    expect(resolveContentDrop(rows, "group:docs:0:Introduction", "group:api:0:Endpoints", "after")).toEqual({
      type: "move_group",
      sectionSlug: "docs",
      groupIndex: 0,
      toSectionSlug: "api",
      beforeGroupIndex: null,
    })
  })

  test("a drop that leaves the group in its place moves nothing", () => {
    expect(planContentDrop(rows, "group:docs:1:Advanced", "page:/install", "after")).toEqual({ edit: null, indicator: null })
  })

  test("refuses a drop onto one of its own pages", () => {
    expect(resolveContentDrop(rows, "group:docs:0:Introduction", "page:/guide", "after")).toBeNull()
  })
})

describe("moving a section", () => {
  const rows = flattenContentTree(tree, allOpen)

  test("lands after the target section, below its last row", () => {
    expect(resolveContentDrop(rows, "section:docs", "section:api", "after")).toEqual({
      type: "move_section",
      slug: "docs",
      beforeSlug: null,
    })
    expect(resolveDropIndicator(rows, "section:docs", "section:api", "after")).toEqual({
      rowId: "page:/api/list",
      edge: "bottom",
      depth: 0,
    })
  })

  test("lands before the target section", () => {
    expect(resolveContentDrop(rows, "section:api", "section:docs", "before")).toEqual({
      type: "move_section",
      slug: "api",
      beforeSlug: "docs",
    })
  })

  test("a drop that leaves the section in its place moves nothing", () => {
    expect(planContentDrop(rows, "section:docs", "section:api", "before")).toEqual({ edit: null, indicator: null })
  })

  test("refuses a drop inside itself", () => {
    expect(resolveContentDrop(rows, "section:docs", "group:docs:1:Advanced", "after")).toBeNull()
    expect(planContentDrop(rows, "section:docs", "page:/guide", "after")).toBeNull()
  })
})

describe("applyOptimisticMove", () => {
  const overview = createOverview()

  test("reorders pages inside one group", () => {
    const next = applyOptimisticMove(overview, {
      type: "move_page",
      href: "/",
      toSectionSlug: "docs",
      toGroupIndex: 0,
      beforeHref: null,
    })

    expect(next?.navigation[0].groups[0].hrefs).toEqual(["/guide", "/install", "/"])
    expect(overview.navigation[0].groups[0].hrefs).toEqual(["/", "/guide", "/install"])
  })

  test("reorders sections", () => {
    const next = applyOptimisticMove(overview, {
      type: "move_section",
      slug: "docs",
      beforeSlug: null,
    })

    expect(next?.navigation.map((section) => section.slug)).toEqual(["api", "docs"])
  })

  test("moves a group and renumbers every group in both sections", () => {
    const next = applyOptimisticMove(overview, {
      type: "move_group",
      sectionSlug: "docs",
      groupIndex: 0,
      toSectionSlug: "api",
      beforeGroupIndex: 0,
    })

    expect(next?.navigation[0].groups).toEqual([
      { heading: "Advanced", groupIndex: 0, hrefs: ["/advanced"] },
    ])
    expect(next?.navigation[1].groups).toEqual([
      {
        heading: "Introduction",
        groupIndex: 0,
        hrefs: ["/api", "/api/guide", "/api/install"],
      },
      { heading: "Endpoints", groupIndex: 1, hrefs: ["/api/list"] },
    ])
  })

  test("moves a page across sections and rewrites both navigation and page metadata", () => {
    const next = applyOptimisticMove(overview, {
      type: "move_page",
      href: "/guide",
      toSectionSlug: "api",
      toGroupIndex: null,
      beforeHref: null,
    })

    expect(next?.navigation[0].groups[0].hrefs).toEqual(["/", "/install"])
    expect(next?.navigation[1].groups[0]).toEqual({
      heading: null,
      groupIndex: null,
      hrefs: ["/api/guide"],
    })
    expect(next?.pages.find((candidate) => candidate.href === "/api/guide")).toMatchObject({
      href: "/api/guide",
      sourcePath: "source/api/guide/index.mdx",
    })
  })
})

describe("movesAcrossSections", () => {
  const navigation = createOverview().navigation

  test("returns true only when the selected page receives a new section prefix", () => {
    expect(
      movesAcrossSections(
        {
          type: "move_page",
          href: "/guide",
          toSectionSlug: "api",
          toGroupIndex: null,
          beforeHref: null,
        },
        "/guide",
        navigation,
      ),
    ).toBe(true)
    expect(
      movesAcrossSections(
        {
          type: "move_page",
          href: "/guide",
          toSectionSlug: "docs",
          toGroupIndex: 1,
          beforeHref: null,
        },
        "/guide",
        navigation,
      ),
    ).toBe(false)
    expect(
      movesAcrossSections(
        {
          type: "move_group",
          sectionSlug: "docs",
          groupIndex: 1,
          toSectionSlug: "api",
          beforeGroupIndex: null,
        },
        "/guide",
        navigation,
      ),
    ).toBe(false)
  })

  test("detects a selected page inside a group that enters another section", () => {
    expect(
      movesAcrossSections(
        {
          type: "move_group",
          sectionSlug: "docs",
          groupIndex: 1,
          toSectionSlug: "api",
          beforeGroupIndex: null,
        },
        "/advanced",
        navigation,
      ),
    ).toBe(true)
  })
})

function section(
  slug: string,
  label: string,
  groups: ContentTreeGroup[],
): ContentTreeSection {
  return { slug, label, isDefault: slug === "docs", groups, editedCount: 0 }
}

function group(
  id: string,
  groupIndex: number | null,
  heading: string | null,
  hrefs: string[],
): ContentTreeGroup {
  return { id, groupIndex, heading, pages: hrefs.map(page), editedCount: 0 }
}

function page(href: string): DocsContentPageDto {
  return {
    href,
    title: href,
    status: "published",
    sourcePath: `source${href === "/" ? "/index" : href}.mdx`,
    icon: null,
  }
}

function createOverview(): DocsContentOverviewDto {
  return {
    projectId: "project",
    projectSlug: "project",
    siteId: "site",
    publishedVersion: { id: "v1", versionNumber: 1, createdAt: "2026-08-19T00:00:00.000Z" },
    working: { branchId: null, baseVersionId: "v1", editedHrefs: [], changeCount: 0, revision: 0, createdAt: null, updatedAt: null, isBaseCurrent: true },
    ...overviewSiteSettings(),
    pages: ["/", "/guide", "/install", "/advanced", "/api/list"].map(page),
    navigation: [
      {
        slug: "docs",
        label: "Documentation",
        isDefault: true,
        groups: [
          { heading: "Introduction", groupIndex: 0, hrefs: ["/", "/guide", "/install"] },
          { heading: "Advanced", groupIndex: 1, hrefs: ["/advanced"] },
        ],
      },
      {
        slug: "api",
        label: "API",
        isDefault: false,
        groups: [{ heading: "Endpoints", groupIndex: 0, hrefs: ["/api/list"] }],
      },
    ],
  }
}

describe("pointerTarget", () => {
  // Three 30px rows, as measured when the drag started.
  const boxes = [
    { id: "a", top: 0, bottom: 30 },
    { id: "b", top: 30, bottom: 60 },
    { id: "c", top: 60, bottom: 90 },
  ]

  test("names the row under the pointer and the half it is in", () => {
    expect(pointerTarget(boxes, 35)).toEqual({ overId: "b", placement: "before" })
    expect(pointerTarget(boxes, 50)).toEqual({ overId: "b", placement: "after" })
  })

  test("clamps above the first row and below the last", () => {
    expect(pointerTarget(boxes, -20)).toEqual({ overId: "a", placement: "before" })
    expect(pointerTarget(boxes, 200)).toEqual({ overId: "c", placement: "after" })
  })
})

describe("keyboardMoveTarget", () => {
  const rows = flattenContentTree(tree, allOpen)
  const move = (id: string, direction: "up" | "down") => {
    const target = keyboardMoveTarget(rows, id, direction)
    return target ? resolveContentDrop(rows, id, target.overId, target.placement) : null
  }

  test("moves a page one place within its group", () => {
    expect(move("page:/guide", "up")).toMatchObject({ toGroupIndex: 0, beforeHref: "/" })
    expect(move("page:/guide", "down")).toMatchObject({ toGroupIndex: 0, beforeHref: null })
  })

  test("moves the last page of a group down into the next group", () => {
    expect(move("page:/install", "down")).toMatchObject({ toGroupIndex: 1, beforeHref: "/advanced" })
  })

  test("moves the first page of a group up out of it", () => {
    expect(move("page:/advanced", "up")).toMatchObject({ toGroupIndex: 0, beforeHref: null })
  })

  test("moves a group past the whole next group", () => {
    expect(move("group:docs:0:Introduction", "down")).toMatchObject({ type: "move_group", beforeGroupIndex: null })
  })

  test("has nowhere to go past the ends", () => {
    expect(move("section:docs", "up")).toBeNull()
    expect(move("section:api", "down")).toBeNull()
  })
})

describe("springOpenTarget", () => {
  const closed = new Set(["docs", "docs:0:Introduction"])
  const rows = flattenContentTree(tree, closed)

  test("opens a closed group or section a page rests on", () => {
    expect(springOpenTarget(rows, "page:/guide", "group:docs:1:Advanced", closed)).toBe("docs:1:Advanced")
    expect(springOpenTarget(rows, "page:/guide", "section:api", closed)).toBe("api")
  })

  test("opens a closed section for a dragged group, never a group", () => {
    expect(springOpenTarget(rows, "group:docs:0:Introduction", "section:api", closed)).toBe("api")
    expect(springOpenTarget(rows, "group:docs:0:Introduction", "group:docs:1:Advanced", closed)).toBeNull()
  })

  test("leaves an open branch, a page row and a dragged section alone", () => {
    expect(springOpenTarget(rows, "page:/guide", "group:docs:0:Introduction", closed)).toBeNull()
    expect(springOpenTarget(rows, "page:/guide", "page:/install", closed)).toBeNull()
    expect(springOpenTarget(rows, "section:docs", "section:api", closed)).toBeNull()
  })

  test("never opens the section of unplaced pages", () => {
    const orphan: ContentTreeSection[] = [...tree, section("__other", "Other", [group("__other:x", null, null, ["/stray"])])]
    const orphanRows = flattenContentTree(orphan, closed)
    expect(springOpenTarget(orphanRows, "page:/guide", "section:__other", closed)).toBeNull()
  })
})

describe("destinationExpandIds", () => {
  const rows = flattenContentTree(tree, allOpen)

  test("keeps the section and the group a page lands in", () => {
    expect(
      destinationExpandIds(rows, { type: "move_page", href: "/", toSectionSlug: "docs", toGroupIndex: 1, beforeHref: null }),
    ).toEqual(["docs", "docs:1:Advanced"])
    expect(
      destinationExpandIds(rows, { type: "move_page", href: "/", toSectionSlug: "api", toGroupIndex: null, beforeHref: null }),
    ).toEqual(["api"])
  })

  test("keeps the section a group lands in, and nothing for a section", () => {
    expect(
      destinationExpandIds(rows, { type: "move_group", sectionSlug: "docs", groupIndex: 1, toSectionSlug: "api", beforeGroupIndex: null }),
    ).toEqual(["api"])
    expect(destinationExpandIds(rows, { type: "move_section", slug: "api", beforeSlug: "docs" })).toEqual([])
  })
})
