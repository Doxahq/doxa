import { describe, expect, it } from "vitest"
import { BANDS, bandRows } from "~/lib/marketing/bands"

describe("bandRows", () => {
  it("gives the same layout for the same seed, so server and client markup match", () => {
    expect(bandRows({ ...BANDS.hero })).toEqual(bandRows({ ...BANDS.hero }))
    expect(bandRows(BANDS.hero)).not.toEqual(bandRows(BANDS.beforeCta))
  })

  it("has one row per spec row and keeps every cell inside the band", () => {
    const rows = bandRows(BANDS.hero)
    expect(rows).toHaveLength(BANDS.hero.rows)
    for (const cells of rows) {
      for (const cell of cells) {
        const left = Number.parseFloat(cell.left)
        const width = Number.parseFloat(cell.width)
        expect(left).toBeGreaterThanOrEqual(0)
        expect(left + width).toBeLessThanOrEqual(100.001)
      }
    }
  })

  it("puts more cells near the edges than in the middle", () => {
    let edge = 0
    let middle = 0
    for (const cells of bandRows({ seed: 99, rows: 40, cols: 30, density: 1 })) {
      for (const cell of cells) {
        const left = Number.parseFloat(cell.left)
        if (left < 25 || left >= 75) edge++
        else middle++
      }
    }
    expect(edge).toBeGreaterThan(middle)
  })
})
