import { describe, expect, it } from "vitest"
import { FOOTER_MARK_ROWS, pixelGridSize, pixelPaths } from "~/lib/marketing/footer-mark"

describe("pixelPaths", () => {
  it("draws one rectangle per run of cells with the same tone", () => {
    expect(pixelPaths(["##+ *", " ##"])).toEqual({
      solid: "M0 0h2v1h-2zM1 1h2v1h-2z",
      edge: "M2 0h1v1h-1z",
      spark: "M4 0h1v1h-1z",
    })
  })

  it("draws nothing for empty cells", () => {
    expect(pixelPaths(["   ", ""])).toEqual({ solid: "", edge: "", spark: "" })
  })
})

describe("FOOTER_MARK_ROWS", () => {
  it("is a rectangular grid of known cells", () => {
    const { cols, rows } = pixelGridSize(FOOTER_MARK_ROWS)
    expect(rows).toBeGreaterThan(0)
    for (const row of FOOTER_MARK_ROWS) {
      expect(row).toHaveLength(cols)
      expect(row).toMatch(/^[#+* ]*$/)
    }
  })

  it("dissolves toward the bottom: the last row has fewer cells than the first solid row", () => {
    const filled = (row: string) => row.replaceAll(" ", "").length
    expect(filled(FOOTER_MARK_ROWS.at(-1) ?? "")).toBeLessThan(filled(FOOTER_MARK_ROWS[1] ?? ""))
  })
})
