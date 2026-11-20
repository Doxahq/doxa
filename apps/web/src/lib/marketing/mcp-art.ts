import { themedPictureFiles } from "~/lib/theme/picture-files"

/**
 * The antenna art of the MCP page, in two widths and two formats. The night files
 * come from `public/marketing/mcp-dish.webp` (2400 × 1000), the master copy. The
 * daylight files come from `public/marketing/mcp-dish-light.webp`: a Seedream 4
 * relight of the night master, with the same pixel band at the foot.
 */
export const MCP_ART = {
  files: themedPictureFiles("/marketing/mcp-dish", [1200, 2400], 1200),
  width: 2400,
  height: 1000,
  /**
   * The art box is as wide as the page column (1200 px, growing to 1520 px on big
   * screens), inside a 20 px gutter. Under 760 px the box is 4:3 and the 12:5 image
   * covers it, so the image is 1.8 times as wide.
   */
  sizes: "(max-width: 760px) calc((100vw - 40px) * 1.8), (max-width: 1240px) calc(100vw - 40px), clamp(1200px, 72vw, 1520px)",
  /** A 24 × 10 copy of each photo, drawn blurred under the image until the image loads. */
  placeholder: {
    dark: "data:image/webp;base64,UklGRogAAABXRUJQVlA4IHwAAADwAwCdASoYAAoAPrVWoUsnJSMhsAgA4BaJQApgAPRAQqDLdZKV353AAP74TYjsJ6BFJ7BMYus7NjR1K4efk47eb9HhEi3x9yPQb4bT2K06Ubmf/ZUFXTs4NoWesur6A+EMoWDzZtaW2hfiSWHtzFnDKhPHSNho/eNIeAAA",
    light:
      "data:image/webp;base64,UklGRnQAAABXRUJQVlA4IGgAAADQAwCdASoYAAoAPrVKoUmnJCOhMAgA4BaJZQABHuxb1OqzGYZyTfAA/v7svaE31z28PB+jtN9qSZnaFQ3sewzafN4j+4BYST+VyWa5ob7X6QdX3LqT/s0g8vmLOrlefxzGXrGCwAAAAA==",
  },
} as const
