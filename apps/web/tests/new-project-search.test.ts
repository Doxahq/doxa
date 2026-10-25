import { describe, expect, test } from "vitest"

import { parseNewProjectSearch } from "~/lib/dashboard/new-project-search"

describe("new project search", () => {
  test("opens the repository or template dialog on arrival", () => {
    expect(parseNewProjectSearch({ start: "repository" })).toEqual({ start: "repository" })
    expect(parseNewProjectSearch({ start: "template" })).toEqual({ start: "template" })
  })

  test("ignores any other value", () => {
    expect(parseNewProjectSearch({})).toEqual({})
    expect(parseNewProjectSearch({ start: "github" })).toEqual({})
    expect(parseNewProjectSearch({ start: 1 })).toEqual({})
  })
})
