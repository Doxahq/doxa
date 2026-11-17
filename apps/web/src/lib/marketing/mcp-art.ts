/**
 * The antenna art of the MCP page, in two widths and two formats. The files
 * come from `public/marketing/mcp-dish.webp` (2400 × 1000), the master copy.
 * The route preloads the AVIF set, so the image arrives with the page and not
 * after the animation starts.
 */
export const MCP_ART = {
  avif: "/marketing/mcp-dish-1200.avif 1200w, /marketing/mcp-dish-2400.avif 2400w",
  webp: "/marketing/mcp-dish-1200.webp 1200w, /marketing/mcp-dish-2400.webp 2400w",
  fallback: "/marketing/mcp-dish-1200.webp",
  width: 2400,
  height: 1000,
  /**
   * The art box is as wide as the page column (1200 px, growing to 1520 px on big
   * screens), inside a 20 px gutter. Under 760 px the box is 4:3 and the 12:5 image
   * covers it, so the image is 1.8 times as wide.
   */
  sizes: "(max-width: 760px) calc((100vw - 40px) * 1.8), (max-width: 1240px) calc(100vw - 40px), clamp(1200px, 72vw, 1520px)",
  /** A 24 × 10 copy, drawn blurred under the image until the image loads. */
  placeholder: "data:image/webp;base64,UklGRogAAABXRUJQVlA4IHwAAADwAwCdASoYAAoAPrVWoUsnJSMhsAgA4BaJQApgAPRAQqDLdZKV353AAP74TYjsJ6BFJ7BMYus7NjR1K4efk47eb9HhEi3x9yPQb4bT2K06Ubmf/ZUFXTs4NoWesur6A+EMoWDzZtaW2hfiSWHtzFnDKhPHSNho/eNIeAAA",
} as const
