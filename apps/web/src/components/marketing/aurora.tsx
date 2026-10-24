import { useEffect, useId, useRef } from "react"

const SDK_URL = "/webgl/unicornStudio.umd.js"
const SCENE_URL = "/webgl/hero-aurora.json"

type UnicornScene = { destroy?: () => void }
type UnicornStudio = {
  addScene: (options: Record<string, unknown>) => Promise<UnicornScene>
}

let sdkPromise: Promise<UnicornStudio | null> | null = null

/** Loads the Unicorn Studio SDK once per page load. */
function loadSdk(): Promise<UnicornStudio | null> {
  const ready = (window as unknown as { UnicornStudio?: UnicornStudio }).UnicornStudio
  if (ready?.addScene) return Promise.resolve(ready)
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve) => {
      const script = document.createElement("script")
      script.src = SDK_URL
      script.async = true
      script.onload = () =>
        resolve((window as unknown as { UnicornStudio?: UnicornStudio }).UnicornStudio ?? null)
      script.onerror = () => {
        sdkPromise = null
        resolve(null)
      }
      document.head.appendChild(script)
    })
  }
  return sdkPromise
}

/**
 * The doxa.so WebGL aurora behind a hero. It renders nothing on the server.
 * `dpi: 1` keeps the coarse film grain of the first doxa.so hero; higher
 * values make the grain finer and the glow flatter.
 */
export function Aurora({ className = "hero__aurora", dpi = 1.5 }: { className?: string; dpi?: number }) {
  const id = `doxa-aurora-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const scene = useRef<UnicornScene | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadSdk().then((sdk) => {
      if (!sdk || cancelled || !document.getElementById(id)) return
      sdk
        .addScene({
          elementId: id,
          filePath: SCENE_URL,
          scale: 1,
          dpi,
          fps: 60,
          lazyLoad: false,
          production: true,
        })
        .then((s) => {
          if (cancelled) s?.destroy?.()
          else scene.current = s
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
      scene.current?.destroy?.()
      scene.current = null
    }
  }, [id, dpi])

  return <div className={className} id={id} aria-hidden="true" />
}
