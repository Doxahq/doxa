import { Link } from "@tanstack/react-router"

const LOGO_ASPECT = 193 / 160

const MARK_PATH =
  "M59.6064 0.594138C33.4643 0.594138 12.0754 14.8535 4.9457 38.619C-4.56052 71.8908 0.192588 121.798 14.4519 155.07C28.7112 185.965 57.2299 197.848 85.7485 190.718C119.02 181.212 147.539 150.317 157.045 114.669C166.551 74.2673 152.292 33.8659 126.15 14.8535C109.514 2.97069 83.372 -1.78242 59.6064 0.594138Z"
const EYE_PATH =
  "M73.8658 109.321C83.3816 109.321 91.0958 101.607 91.0958 92.0913C91.0958 82.5755 83.3816 74.8613 73.8658 74.8613C64.3499 74.8613 56.6357 82.5755 56.6357 92.0913C56.6357 101.607 64.3499 109.321 73.8658 109.321Z"

interface LogoProps {
  size?: number
  className?: string
}

interface LogoGlyphProps {
  width: number
  height: number
  className?: string
}

/**
 * The Doxa logo as an inline SVG (`public/doxa-logo-new-light.svg`). Its two
 * colors are the `--logo-mark` and `--logo-eye` tokens, so it follows the theme.
 */
export function LogoGlyph({ width, height, className }: LogoGlyphProps) {
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 160 193" aria-hidden="true">
      <path d={MARK_PATH} fill="var(--logo-mark)" />
      <path d={EYE_PATH} fill="var(--logo-eye)" />
    </svg>
  )
}

export function LogoMark({ size = 28 }: { size?: number }) {
  const height = size * LOGO_ASPECT

  return (
    <span className="inline-block shrink-0" style={{ width: size, height }} aria-hidden="true">
      <LogoGlyph width={size} height={height} className="block size-full" />
    </span>
  )
}

/** The mark with the "doxa" wordmark beside it, without a link. */
export function LogoWordmark({ size = 16, className }: LogoProps) {
  return (
    <span className={`flex items-center gap-1.5 ${className ?? ""}`}>
      <LogoMark size={size} />
      <span className="font-mono text-sm font-bold tracking-[0.2em] text-foreground uppercase">
        doxa
      </span>
    </span>
  )
}

export function Logo({ size = 16, className }: LogoProps) {
  return (
    <Link to="/" aria-label="Doxa home" className={`flex ${className ?? ""}`}>
      <LogoWordmark size={size} />
    </Link>
  )
}
