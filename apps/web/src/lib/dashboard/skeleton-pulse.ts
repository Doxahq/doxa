import { useLayoutEffect, useRef, type CSSProperties } from "react"

/** Tailwind's `animate-pulse` cycle. */
const PULSE_MS = 2000
const PULSE_DELAY_VAR = "--skeleton-pulse-delay"

/**
 * Ties the shimmer of a skeleton to the page clock instead of its mount time.
 *
 * A skeleton that replaces another one (the route's pending view, then the
 * page's own) would restart its shimmer at full brightness, which reads as a
 * blink. With a negative delay from the clock, every skeleton on the page is
 * at the same point of the cycle, so a new one continues where the old one
 * was, and the sidebar and the page shimmer together.
 *
 * Put the returned ref on the skeleton's root, and `SKELETON_PULSE_STYLE` on
 * each pulsing bar.
 */
export function useSkeletonPulse<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    ref.current?.style.setProperty(PULSE_DELAY_VAR, `-${Math.round(performance.now() % PULSE_MS)}ms`)
  }, [])
  return ref
}

/** The animation delay of a bar under a root that `useSkeletonPulse` set. */
export const SKELETON_PULSE_STYLE: CSSProperties = { animationDelay: `var(${PULSE_DELAY_VAR}, 0ms)` }
