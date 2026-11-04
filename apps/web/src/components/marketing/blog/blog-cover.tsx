const TINTS = ["blue", "ice", "lav", "deep"] as const
const TEXTURES = ["grid", "dots", "lines"] as const
const GLYPHS = "+·:/\\=#01"
const EDGE_LENGTH = 96

function hashSlug(slug: string) {
  let hash = 7
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 2147483647
  return hash
}

/** A line of small characters, the same on the server and the client. */
function edgeGlyphs(seed: number) {
  let s = seed || 1
  let line = ""
  for (let i = 0; i < EDGE_LENGTH; i++) {
    s = (s * 16807) % 2147483647
    line += i % 4 === 3 ? " " : GLYPHS[s % GLYPHS.length]
  }
  return line
}

/**
 * The drawn cover of a post: the title on a tinted field. The slug picks the
 * tint, the texture and the characters at the edge, so a post always keeps its
 * cover. The title is also the heading next to the cover, so readers of the
 * page text skip this copy. A post with its own `image` shows only the image.
 */
export function BlogCover({ slug, title, image }: { slug: string; title: string; image?: string }) {
  if (image) {
    return (
      <div className="cover cover--image" aria-hidden="true">
        <img src={image} alt="" width={2000} height={1125} decoding="async" />
      </div>
    )
  }

  const hash = hashSlug(slug)
  const tint = TINTS[hash % TINTS.length]
  const texture = TEXTURES[(hash >> 3) % TEXTURES.length]

  return (
    <div className={`cover cover--${tint} cover--${texture}`} aria-hidden="true">
      <i className="cover__mark cover__mark--tl" />
      <i className="cover__mark cover__mark--tr" />
      <i className="cover__mark cover__mark--bl" />
      <i className="cover__mark cover__mark--br" />
      <span className="cover__edge cover__edge--top">{edgeGlyphs(hash)}</span>
      <span className="cover__title">{title}</span>
      <span className="cover__edge cover__edge--bottom">{edgeGlyphs(hash + 1)}</span>
    </div>
  )
}
