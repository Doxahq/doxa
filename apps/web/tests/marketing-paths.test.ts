import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { isMarketingPath } from "~/lib/marketing/marketing-paths"

describe("isMarketingPath", () => {
  it("matches the pages that change for a signed-in visitor, with or without a trailing slash", () => {
    for (const path of ["/", "/pricing", "/pricing/"]) {
      expect(isMarketingPath(path), path).toBe(true)
    }
  })

  it("does not match the always static pages, the app, its assets or look-alike paths", () => {
    for (const path of ["/agent", "/mcp", "/about", "/legal", "/legal/terms", "/blog", "/blog/a-post", "/dashboard", "/login", "/signup", "/pricing-old", "/assets/app.js", "/_serverFn/x"]) {
      expect(isMarketingPath(path), path).toBe(false)
    }
  })

  it("covers every path that wrangler.json runs the worker first for", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8")) as {
      assets: { binding: string; run_worker_first: string[] }
    }
    expect(config.assets.binding).toBe("ASSETS")
    for (const pattern of config.assets.run_worker_first) {
      expect(isMarketingPath(pattern), pattern).toBe(true)
    }
  })
})
