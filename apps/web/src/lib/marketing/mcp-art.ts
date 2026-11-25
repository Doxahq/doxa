import { themedPictureFiles } from "~/lib/theme/picture-files"

/**
 * The antenna art of the MCP page, in two widths and two formats. The night files
 * come from `public/marketing/mcp-dish.webp` (2400 × 1000), the master copy. The
 * daylight files come from `public/marketing/mcp-dish-light.webp`, which a script
 * made from the night master, with no AI step:
 * - The antenna's matte comes from the red channel. The sky, the blue glows and the
 *   blue squares have little red. Parts under 40 px (the stars) are dropped.
 * - The two glows are subtracted ring by ring before the cut, so their white cores
 *   do not stay as blobs.
 * - The sky amount comes from the blue channel: black is the page (#fafafa), the
 *   navy sky is #cfdcf6, and the bright squares go on to #8fabf0. The stars are
 *   filled from the sky around them, and the sky above the pixel band is smoothed.
 * - The antenna is drawn in ink: bright metal maps to #132046, dim metal to #5d7fd6.
 * The cut edges are those of the night photo, and the pixel band and the feed point
 * stay where they are.
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
      "data:image/webp;base64,UklGRnQAAABXRUJQVlA4IGgAAACwAwCdASoYAAoALoVarVaipycnBwCESygAHxFg3+J6ibX9HdOmAAD+/BMZiakYrIRxnAV6j580w6cKdWOeZO7Z9d2eF4DXvnazy42n/bYdvfHN+KgwT+CWKtEu+Qh7S17zpNRcDPwYAA==",
  },
} as const
