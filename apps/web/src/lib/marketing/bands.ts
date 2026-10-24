export type BandCellKind = "c-lav" | "c-deep" | "c-blue" | "c-ice" | "c-pale"

export interface BandCell {
  kind: BandCellKind
  /** Left edge, as a CSS percentage. */
  left: string
  width: string
}

export interface BandSpec {
  seed: number
  rows: number
  cols: number
  density: number
}

const cache = new Map<string, BandCell[][]>()

/**
 * The rows of a decorative box band, denser at the edges like baseten.co.
 * The seeded generator gives the same layout on the server and the client.
 */
export function bandRows({ seed, rows, cols, density }: BandSpec): BandCell[][] {
  const key = `${seed}:${rows}:${cols}:${density}`
  const hit = cache.get(key)
  if (hit) return hit

  let s = seed
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }

  const out: BandCell[][] = []
  for (let r = 0; r < rows; r++) {
    const cells: BandCell[] = []
    let c = 0
    while (c < cols) {
      const w = 1 + Math.floor(rnd() * 4)
      const mid = (c + w / 2) / cols
      const edge = Math.abs(mid - 0.5) * 2
      if (rnd() < density * (0.15 + 0.85 * edge * edge)) {
        const k = rnd()
        const kind: BandCellKind =
          k < 0.07 ? "c-lav" : k < 0.3 ? "c-deep" : k < 0.62 ? "c-blue" : k < 0.72 ? "c-ice" : "c-pale"
        // The design drew two more numbers per cell for its old wipe timing. Keep
        // drawing them so the layout stays the same.
        rnd()
        rnd()
        cells.push({
          kind,
          left: `${((c / cols) * 100).toFixed(3)}%`,
          width: `${((Math.min(w, cols - c) / cols) * 100).toFixed(3)}%`,
        })
      }
      c += w
    }
    out.push(cells)
  }
  cache.set(key, out)
  return out
}

/** The bands of the v11 design: under the hero, before the CTA, before the footer, and more. */
export const BANDS = {
  hero: { seed: 7, rows: 3, cols: 30, density: 1 },
  plans: { seed: 43, rows: 3, cols: 30, density: 0.8 },
  beforeCta: { seed: 19, rows: 3, cols: 30, density: 0.7 },
  beforeFooter: { seed: 31, rows: 3, cols: 30, density: 0.7 },
  extra: { seed: 57, rows: 3, cols: 30, density: 0.7 },
} satisfies Record<string, BandSpec>
