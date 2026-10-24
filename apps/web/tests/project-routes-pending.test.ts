import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const projectRoutes = fileURLToPath(new URL("../src/routes/dashboard/projects/$projectId", import.meta.url))

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? routeFiles(path) : path.endsWith(".tsx") ? [path] : []
  })
}

describe("project page routes", () => {
  // Every page in a project shows the same loading view and switches the
  // sidebar with it. A new page route must spread `projectPagePending`.
  test("every project page uses the shared loading options", () => {
    const pages = routeFiles(projectRoutes)
      .filter((path) => relative(projectRoutes, path) !== "route.tsx")
      .filter((path) => /\bcomponent:/.test(readFileSync(path, "utf8")))
    expect(pages.length).toBeGreaterThanOrEqual(12)
    for (const path of pages) {
      expect(readFileSync(path, "utf8"), relative(projectRoutes, path)).toContain("...projectPagePending,")
    }
  })
})
