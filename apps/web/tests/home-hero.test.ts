import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  HERO_V2_IMAGES,
  HOME_HERO_VERSION,
  heroSrc,
  heroSrcSet,
} from "~/lib/marketing/home-hero"

const PUBLIC_DIR = join(__dirname, "..", "public")

describe("home hero", () => {
  it("names a hero that exists", () => {
    expect(["v1", "v2"]).toContain(HOME_HERO_VERSION)
  })

  it("lists every exported width in the srcset", () => {
    expect(heroSrcSet(HERO_V2_IMAGES.docs, "avif")).toBe(
      "/marketing/hero/docs-shot-720.avif 720w, /marketing/hero/docs-shot-1040.avif 1040w, /marketing/hero/docs-shot-2080.avif 2080w",
    )
  })

  it("falls back to the first WebP that covers a 1440px screen", () => {
    expect(heroSrc(HERO_V2_IMAGES.back)).toBe("/marketing/hero/dunes-back-1440.webp")
    expect(heroSrc(HERO_V2_IMAGES.docs)).toBe("/marketing/hero/docs-shot-2080.webp")
  })

  it("has a file in public/ for every size and format", () => {
    for (const image of Object.values(HERO_V2_IMAGES)) {
      for (const format of ["avif", "webp"] as const) {
        for (const width of image.widths) {
          expect(existsSync(join(PUBLIC_DIR, `${image.base}-${width}.${format}`)), `${image.base}-${width}.${format}`).toBe(true)
        }
      }
    }
  })

})
