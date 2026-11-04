const MIN_FRAME_MS = 1000 / 60
/** A long frame does not jump the animation forward. */
const MAX_STEP_SECONDS = 0.05
const MAX_JUMPS_TO_REST = 8

export interface ArtLoop {
  /** True when the animation runs. It starts true. */
  readonly playing: boolean
  setPlaying(playing: boolean): void
  /** Stops the loop and the observers. */
  stop(): void
}

export interface LoopArt {
  resize(): void
  update(seconds: number): void
  draw(): void
  /**
   * The seconds to the next place where the art looks right when it stops, and 0 when
   * it is at such a place. Without this, the art stops anywhere.
   */
  secondsToRest?(): number
}

/**
 * Runs art on a canvas: it draws once at once, then plays while the visitor wants it
 * and can see it. It draws at most 60 frames a second. After a pause, the animation
 * continues from where it stopped.
 *
 * The Pause button stops the art at once. When the visitor stops seeing the art, the
 * art first goes on to its next rest, with no draws, and then it stops. The canvas
 * counts as seen when this share of it, or more, is in the window.
 */
export function startArtLoop(canvas: HTMLCanvasElement, art: LoopArt, { seenShare = 0 }: { seenShare?: number } = {}): ArtLoop {
  let raf = 0
  let last = 0
  let stopped = false
  let playing = true
  let onScreen = false

  const seen = () => onScreen && !document.hidden
  const secondsToRest = () => art.secondsToRest?.() ?? 0

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const elapsed = now - last
    if (elapsed < MIN_FRAME_MS - 1) return
    last = now
    art.update(Math.min(elapsed / 1000, MAX_STEP_SECONDS))
    if (seen() || secondsToRest() === 0) art.draw()
    updateLoop()
  }

  const updateLoop = () => {
    const run = !stopped && playing && (seen() || secondsToRest() > 0)
    if (run && !raf) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    } else if (!run && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  const resized = new ResizeObserver(() => {
    art.resize()
    art.draw()
  })
  resized.observe(canvas)
  const inWindow = new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting && entry.intersectionRatio >= seenShare
      updateLoop()
    },
    { threshold: seenShare },
  )
  inWindow.observe(canvas)

  // A hidden page gets no frames, so the art cannot go on to its rest. Nobody sees it, so it jumps there.
  const visibilityChanged = () => {
    if (document.hidden && playing && !stopped && secondsToRest() > 0) {
      // Art can need more than one jump, when its next rest depends on what happens on the way.
      for (let i = 0; i < MAX_JUMPS_TO_REST && secondsToRest() > 0; i++) art.update(secondsToRest())
      art.draw()
    }
    updateLoop()
  }
  document.addEventListener("visibilitychange", visibilityChanged)

  const lost = (event: Event) => {
    event.preventDefault()
    stopped = true
    updateLoop()
  }
  canvas.addEventListener("webglcontextlost", lost)

  art.resize()
  art.draw()

  return {
    get playing() {
      return playing
    },
    setPlaying(next) {
      playing = next
      // The art can be on its way to a rest with no draws. A pause must show where it is.
      if (!playing) art.draw()
      updateLoop()
    },
    stop() {
      stopped = true
      updateLoop()
      resized.disconnect()
      inWindow.disconnect()
      document.removeEventListener("visibilitychange", visibilityChanged)
      canvas.removeEventListener("webglcontextlost", lost)
    },
  }
}
