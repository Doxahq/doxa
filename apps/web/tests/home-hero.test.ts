import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { HERO_V2_IMAGES, HOME_HERO_VERSION } from "~/lib/marketing/home-hero"
import { MCP_ART } from "~/lib/marketing/mcp-art"
import type { PictureFiles } from "~/lib/theme/picture-files"
import { THEMES, type Themed } from "~/lib/theme/theme"

const PUBLIC_DIR = join(__dirname, "..", "public")

/** Every file that a picture names: each `srcset` entry and the fallback. */
function picturePaths(files: PictureFiles): string[] {
  const entries = [files.avif, files.webp].flatMap((srcSet) => srcSet?.split(", ") ?? [])
  return [...entries.map((entry) => entry.split(" ")[0]), files.fallback]
}

function themedPicturePaths(files: Themed<PictureFiles>): string[] {
  return THEMES.flatMap((theme) => picturePaths(files[theme]))
}

describe("home hero", () => {
  it("names a hero that exists", () => {
    expect(["v1", "v2"]).toContain(HOME_HERO_VERSION)
  })

  it("lists every exported width in the srcset", () => {
    expect(HERO_V2_IMAGES.docs.files.dark.avif).toBe(
      "/marketing/hero/docs-shot-720.avif 720w, /marketing/hero/docs-shot-1040.avif 1040w, /marketing/hero/docs-shot-2080.avif 2080w",
    )
  })

  it("shows the night dunes in both themes", () => {
    expect(HERO_V2_IMAGES.back.files.light).toEqual(HERO_V2_IMAGES.back.files.dark)
    expect(HERO_V2_IMAGES.front.files.light).toEqual(HERO_V2_IMAGES.front.files.dark)
  })

  it("names the light docs shot with a -light suffix in the same widths", () => {
    expect(HERO_V2_IMAGES.docs.files.light.webp).toBe(
      HERO_V2_IMAGES.docs.files.dark.webp.replaceAll("/docs-shot-", "/docs-shot-light-"),
    )
  })

  it("falls back to the first WebP that covers a 1440px screen", () => {
    expect(HERO_V2_IMAGES.back.files.dark.fallback).toBe("/marketing/hero/dunes-back-1440.webp")
    expect(HERO_V2_IMAGES.docs.files.dark.fallback).toBe("/marketing/hero/docs-shot-2080.webp")
    expect(HERO_V2_IMAGES.docs.files.light.fallback).toBe("/marketing/hero/docs-shot-light-2080.webp")
  })

  it("has a file in public/ for every size, format and theme", () => {
    const pictures = [...Object.values(HERO_V2_IMAGES).map((image) => image.files), MCP_ART.files]
    for (const path of pictures.flatMap(themedPicturePaths)) {
      expect(existsSync(join(PUBLIC_DIR, path)), path).toBe(true)
    }
  })
})
