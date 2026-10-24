export interface PageSettleOptions {
  /** No request may finish for this long. */
  quietMs?: number
  /** The task runs after this long, even if requests never stop. */
  maxWaitMs?: number
}

const DEFAULT_QUIET_MS = 1_500
const DEFAULT_MAX_WAIT_MS = 20_000
const IDLE_TIMEOUT_MS = 2_000

/**
 * Runs `task` once, after the page settles: the load event fired, no request
 * finished for `quietMs`, and the browser is idle. Use it for background work
 * that must not slow the page the person opened. Returns a cancel function.
 */
export function whenPageSettles(task: () => void, options: PageSettleOptions = {}): () => void {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS
  let cancelled = false
  let scheduled = false
  let quietTimer: ReturnType<typeof setTimeout> | undefined
  let observer: PerformanceObserver | undefined
  let cancelIdle: (() => void) | undefined
  const deadline = setTimeout(runWhenIdle, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)

  function stopWatching() {
    clearTimeout(deadline)
    clearTimeout(quietTimer)
    observer?.disconnect()
    window.removeEventListener("load", watchRequests)
  }

  function runWhenIdle() {
    if (cancelled || scheduled) return
    scheduled = true
    stopWatching()
    cancelIdle = onIdle(() => {
      if (!cancelled) task()
    })
  }

  function restartQuietTimer() {
    clearTimeout(quietTimer)
    quietTimer = setTimeout(runWhenIdle, quietMs)
  }

  // A resource entry arrives each time a request finishes.
  function watchRequests() {
    if (typeof PerformanceObserver !== "undefined") {
      try {
        observer = new PerformanceObserver(restartQuietTimer)
        observer.observe({ type: "resource" })
      } catch {
        observer = undefined
      }
    }
    restartQuietTimer()
  }

  if (document.readyState === "complete") watchRequests()
  else window.addEventListener("load", watchRequests, { once: true })

  return () => {
    cancelled = true
    stopWatching()
    cancelIdle?.()
  }
}

function onIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS })
    return () => window.cancelIdleCallback(handle)
  }
  const handle = setTimeout(callback, 0)
  return () => clearTimeout(handle)
}
