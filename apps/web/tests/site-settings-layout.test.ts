import { docsLayout, resolveSiteConfig, sidebarPosition, toEditableSiteConfig } from "@doxahq/site-config"
import { describe, expect, test } from "vitest"

import { withLayout } from "~/lib/dashboard/site-settings-edits"
import { tabForIssue, tabForPointer } from "~/lib/dashboard/site-settings-issues"

describe("sidebar position setting", () => {
  const config = toEditableSiteConfig(resolveSiteConfig({ name: "Docs" }))

  test("page edge is stored, and the default leaves no layout behind", () => {
    const edge = withLayout(config, { sidebar: "page-edge" })
    expect(edge.layout).toEqual({ sidebar: "page-edge", collapsibleGroups: false })
    expect(sidebarPosition(edge)).toBe("page-edge")

    const back = withLayout(edge, { sidebar: "beside-content" })
    expect("layout" in back).toBe(false)
    expect(back).toEqual(config)
  })

  test("collapsible groups keep the other layout value, and turning both back removes the layout", () => {
    const both = withLayout(withLayout(config, { sidebar: "page-edge" }), { collapsibleGroups: true })
    expect(docsLayout(both)).toMatchObject({ sidebar: "page-edge", collapsibleGroups: true })

    const groupsOnly = withLayout(both, { sidebar: "beside-content" })
    expect(groupsOnly.layout).toEqual({ sidebar: "beside-content", collapsibleGroups: true })
    expect("layout" in withLayout(groupsOnly, { collapsibleGroups: false })).toBe(false)
  })

  test("its issues open the Appearance page, where the theme is", () => {
    expect(tabForPointer("/layout/sidebar")).toBe("theme")
    expect(tabForIssue({ path: "/layout/sidebar", code: "invalid_type" })).toBe("theme")
    expect(tabForIssue({ path: "/layout/width", code: "unknown_key" })).toBe("json")
  })
})
