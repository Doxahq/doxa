import { useEffect, useRef } from "react"
import { ctaClickHandler } from "~/lib/analytics/capture-browser-event"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"

const DOCS_DEMO_URL = `${DOCS_URL}/overview/?demo=true`

// The docs site shows its sidebar from 1024px. The iframe renders at least this
// wide and scales down to fit the window, so visitors see the desktop layout.
const DESKTOP_WIDTH = 1100
const DESKTOP_MIN_BOX = 760
const MAX_SCALE = 0.9

/** "A docs site your team does not maintain." with a live demo docs site. */
export function HomeShowcase() {
  return (
    <section className="col" aria-label="The platform">
      <div className="show">
        <div className="show__head">
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <span className="chip" style={{ width: "fit-content" }}>
              The platform
            </span>
            <h2 className="display">
              A docs site your team
              <br />
              does not maintain.
            </h2>
          </div>
          <div className="show__aside">
            <p>
              Every project ships with search, AI chat, versioned branches and previews. Publish to your own domain in
              one click.
            </p>
            <div className="row">
              <a className="btn btn--line btn--sm" href={DOCS_URL}>
                Read the docs ›
              </a>
              <a className="btn btn--light btn--sm" href={GET_STARTED_URL} onClick={ctaClickHandler("home_showcase", "get_started")}>
                Start free ›
              </a>
            </div>
          </div>
        </div>
        <div className="stage">
          <DocsWindow />
        </div>
      </div>
    </section>
  )
}

/** Picks the iframe scale for a window width: desktop layout on wide boxes, mobile layout on narrow ones. */
function scaleFor(width: number) {
  if (width < DESKTOP_MIN_BOX) return MAX_SCALE
  return Math.min(MAX_SCALE, width / DESKTOP_WIDTH)
}

function DocsWindow() {
  const windowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = windowRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      el.style.setProperty("--dwin-scale", String(scaleFor(entry.contentRect.width)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="dwin" ref={windowRef}>
      <iframe src={DOCS_DEMO_URL} title="Doxa documentation demo" loading="eager" />
    </div>
  )
}
