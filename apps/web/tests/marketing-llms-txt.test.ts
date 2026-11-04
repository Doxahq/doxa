import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { LLMS_TXT_URL, MCP_SERVER_URL, SITE_ORIGIN } from "~/lib/marketing/links"
import { PLANS } from "~/lib/marketing/pricing"

const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8")
const fromRoutes = (path: string) => new URL(`../src/routes/_marketing/${path}`, import.meta.url)

/** The site paths that the file links to. */
const sitePaths = [...llms.matchAll(/\]\(https:\/\/doxa\.so\/([^)]+)\)/g)].map((match) => match[1] ?? "")

describe("llms.txt", () => {
  it("is the file that the footer links to", () => {
    expect(LLMS_TXT_URL).toBe("/llms.txt")
    expect(SITE_ORIGIN).toBe("https://doxa.so")
  })

  it("follows the llms.txt format: one title, a summary, then link sections", () => {
    expect(llms.startsWith("# Doxa\n\n> ")).toBe(true)
    expect(llms.match(/^# /gm)).toHaveLength(1)
    expect(llms.match(/^## .+$/gm)).toEqual(["## Product", "## Documentation", "## Company", "## Optional"])
  })

  it("links only to pages that exist, and to no draft post", () => {
    expect(sitePaths.length).toBeGreaterThan(0)
    for (const path of sitePaths) {
      const post = /^blog\/(.+)$/.exec(path)?.[1]
      if (post) {
        const source = readFileSync(new URL(`../src/content/blog/${post}.mdx`, import.meta.url), "utf8")
        expect(source, post).not.toMatch(/^draft:\s*["']?true/m)
        continue
      }
      const route = path === "blog" ? "blog/index.tsx" : `${path}.tsx`
      expect(existsSync(fromRoutes(route)), path).toBe(true)
    }
  })

  it("states the current Pro prices and MCP server address", () => {
    const pro = PLANS.find((plan) => plan.id === "pro")
    expect(llms).toContain(`Pro costs ${String(pro?.billing?.monthly.price)} per month`)
    expect(llms).toContain(`or ${String(pro?.billing?.yearly.price)} per month when billed yearly`)
    expect(llms).toContain(MCP_SERVER_URL)
  })
})
