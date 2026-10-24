import { Link } from "@tanstack/react-router"

const LOGO_ASPECT = 193 / 160

interface LogoProps {
  size?: number
  className?: string
}

export function LogoMark({ size = 28 }: { size?: number }) {
  const height = size * LOGO_ASPECT

  return (
    <span
      className="inline-block shrink-0"
      style={{ width: size, height }}
      aria-hidden="true"
    >
      <img
        src="/doxa-logo-new-light.svg"
        alt=""
        width={size}
        height={height}
        className="block size-full"
        draggable={false}
      />
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
