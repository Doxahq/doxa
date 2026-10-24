/**
 * Mechanical-keyboard audio pipeline used by the terminal-style typewriter.
 *
 * Built around the Web Audio API so we can pre-decode every sample once and
 * fire one-shot `AudioBufferSourceNode`s per keystroke — this is how real-time
 * game audio is mixed and it sidesteps every pitfall of `<audio>` tag playback
 * (overlap cutoffs, mobile latency, garbage-collected elements).
 *
 * Framework-agnostic by design: no React imports, safe to unit test, and easy
 * to swap out for a richer synth later if we want variable pitch per key.
 */

const CLICK_FILES = [
  "click-001.mp3",
  "click-002.mp3",
  "click-003.mp3",
  "click-004.mp3",
  "click-005.mp3",
  "click-006.mp3",
] as const

const DEFAULT_GAIN = 0.3

type AudioContextCtor = typeof AudioContext
const getAudioContextCtor = (): AudioContextCtor | null => {
  if (typeof window === "undefined") return null
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext ??
    null
  )
}

export type KeyboardAudio = {
  /** Fetch + decode every sample. Safe to call repeatedly — only runs once. */
  load: () => Promise<void>
  /** Play a random click, never the same one twice in a row. */
  playClick: () => void
  /** Played once when a backspace run begins. */
  playBackspaceDown: () => void
  /** Played once when a backspace run ends. */
  playBackspaceUp: () => void
  /** Played on a terminal period (e.g. end of a sentence). */
  playPeriod: () => void
  /** Resume the `AudioContext` — required after a user gesture on most browsers. */
  unlock: () => void
  /** Tear down the context. */
  dispose: () => void
}

type AudioBufferOrNull = AudioBuffer | null

export function createKeyboardAudio(
  basePath = "/sound/keyboard",
  gain = DEFAULT_GAIN,
): KeyboardAudio {
  let ctx: AudioContext | null = null
  let loadPromise: Promise<void> | null = null

  let clickBuffers: AudioBuffer[] = []
  let backspaceDown: AudioBufferOrNull = null
  let backspaceUp: AudioBufferOrNull = null
  let period: AudioBufferOrNull = null

  let nextClickIndex = 0

  const ensureContext = (): AudioContext | null => {
    if (ctx) return ctx
    const Ctor = getAudioContextCtor()
    if (!Ctor) return null
    // "interactive" is the default, but we set it explicitly to signal that
    // we want the lowest latency the browser will give us for UI feedback.
    ctx = new Ctor({ latencyHint: "interactive" })
    return ctx
  }

  const fetchBuffer = async (
    context: AudioContext,
    file: string,
  ): Promise<AudioBuffer> => {
    const response = await fetch(`${basePath}/${file}`)
    const bytes = await response.arrayBuffer()
    return context.decodeAudioData(bytes)
  }

  const load = (): Promise<void> => {
    if (loadPromise) return loadPromise
    const context = ensureContext()
    if (!context) return Promise.resolve()

    loadPromise = (async () => {
      const [clicks, bDown, bUp, per] = await Promise.all([
        Promise.all(CLICK_FILES.map((file) => fetchBuffer(context, file))),
        fetchBuffer(context, "backspace-down.mp3"),
        fetchBuffer(context, "backspace-up.mp3"),
        fetchBuffer(context, "period.mp3"),
      ])
      clickBuffers = clicks
      backspaceDown = bDown
      backspaceUp = bUp
      period = per
      // Try to resume eagerly — on repeat visits browsers often allow this
      // without a gesture (Chrome Media Engagement Index, Firefox, etc.).
      if (context.state === "suspended") void context.resume()
    })()

    return loadPromise
  }

  const playBuffer = (buffer: AudioBufferOrNull) => {
    if (!buffer || !ctx) return
    // If the context is suspended, nudge it — the browser may allow it to
    // resume without a gesture on repeat visits or after enough engagement.
    // Skip this particular sound (it would queue at a stale timestamp) but
    // the very next keystroke will likely find the context running.
    if (ctx.state !== "running") {
      if (ctx.state === "suspended") void ctx.resume()
      return
    }
    const source = ctx.createBufferSource()
    const gainNode = ctx.createGain()
    gainNode.gain.value = gain
    source.buffer = buffer
    source.connect(gainNode)
    gainNode.connect(ctx.destination)
    // Schedule at the current context time — playback begins ASAP through
    // the hardware buffer. The typewriter paces keystrokes slowly enough
    // that each click sound has room to ring out before the next arrives.
    source.start(ctx.currentTime)
  }

  const playClick = () => {
    if (clickBuffers.length === 0) return
    // Cycle through the samples in order (click-001 → click-006 → loop)
    // so every keystroke steps forward through the pool like a real keyboard
    // sweeping across keys — never repeats the same sample until the cycle
    // completes.
    const index = nextClickIndex
    nextClickIndex = (nextClickIndex + 1) % clickBuffers.length
    playBuffer(clickBuffers[index])
  }

  const playBackspaceDown = () => playBuffer(backspaceDown)
  const playBackspaceUp = () => playBuffer(backspaceUp)
  const playPeriod = () => playBuffer(period)

  const unlock = () => {
    const context = ensureContext()
    if (context?.state === "suspended") void context.resume()
  }

  const dispose = () => {
    if (ctx) {
      void ctx.close()
      ctx = null
    }
    loadPromise = null
    clickBuffers = []
    backspaceDown = null
    backspaceUp = null
    period = null
    nextClickIndex = 0
  }

  return {
    load,
    playClick,
    playBackspaceDown,
    playBackspaceUp,
    playPeriod,
    unlock,
    dispose,
  }
}
