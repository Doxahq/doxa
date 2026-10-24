// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest"

import {
  clampSidebarWidth,
  readSidebarWidth,
  resolveSidebarDrag,
  SIDEBAR_COLLAPSE_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_SCRIPT,
  writeSidebarWidth,
} from "~/lib/dashboard/sidebar-width"

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute("style")
})

describe("sidebar width", () => {
  test("the default is the old 17rem plus 20%, inside the limits", () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(Math.round(17 * 16 * 1.2))
    expect(SIDEBAR_DEFAULT_WIDTH).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH)
    expect(SIDEBAR_DEFAULT_WIDTH).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH)
    expect(SIDEBAR_COLLAPSE_WIDTH).toBeLessThan(SIDEBAR_MIN_WIDTH)
  })

  test("a width stays between the minimum and the maximum", () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(300.6)).toBe(301)
  })

  test("a drag resizes, stops at the minimum, then closes near the window edge", () => {
    expect(resolveSidebarDrag(400)).toEqual({ kind: "resize", width: 400 })
    expect(resolveSidebarDrag(900)).toEqual({ kind: "resize", width: SIDEBAR_MAX_WIDTH })
    expect(resolveSidebarDrag(SIDEBAR_COLLAPSE_WIDTH)).toEqual({ kind: "resize", width: SIDEBAR_MIN_WIDTH })
    expect(resolveSidebarDrag(SIDEBAR_COLLAPSE_WIDTH - 1)).toEqual({ kind: "collapse" })
    expect(resolveSidebarDrag(0)).toEqual({ kind: "collapse" })
  })

  test("a saved width is read back, and a value out of range is ignored", () => {
    expect(readSidebarWidth()).toBeNull()
    writeSidebarWidth(360)
    expect(readSidebarWidth()).toBe(360)
    localStorage.setItem("doxa:sidebar-width", "9999")
    expect(readSidebarWidth()).toBeNull()
    localStorage.setItem("doxa:sidebar-width", "wide")
    expect(readSidebarWidth()).toBeNull()
    writeSidebarWidth(null)
    expect(localStorage.getItem("doxa:sidebar-width")).toBeNull()
  })

  test("the head script applies only a valid saved width", () => {
    writeSidebarWidth(360)
    new Function(SIDEBAR_WIDTH_SCRIPT)()
    expect(document.documentElement.style.getPropertyValue("--sidebar-saved-width")).toBe("360px")

    document.documentElement.removeAttribute("style")
    localStorage.setItem("doxa:sidebar-width", "10")
    new Function(SIDEBAR_WIDTH_SCRIPT)()
    expect(document.documentElement.style.getPropertyValue("--sidebar-saved-width")).toBe("")
  })
})
