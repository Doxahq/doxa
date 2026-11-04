import { useEffect, useRef, useState } from "react"
import { DoxabotMark, GithubIcon } from "~/components/marketing/agent/agent-icons"
import { Hr } from "~/components/marketing/guides"
import { attachAsciiGrid } from "~/lib/marketing/agent-ascii"

/** Radar targets in the agent core: position in px and the start of their 12s cycle. */
const BLIPS = [
  { left: 149, top: 44, delay: 0.44 },
  { left: 44, top: 68, delay: 3.33 },
  { left: 148, top: 141, delay: 5.44 },
  { left: 51, top: 114, delay: 6.83, lav: true },
  { left: 160, top: 91, delay: 8.89 },
  { left: 56, top: 165, delay: 10.39 },
]

const PAGES = [
  { path: "api/users", hit: true },
  { path: "guides/pagination", hit: true },
  { path: "api/orders", hit: false },
  { path: "quickstart", hit: false },
  { path: "authentication", hit: false },
  { path: "webhooks", hit: false },
]

/**
 * Section 00: a pull request changes one file, the agent reads it, and the
 * docs preview marks the two pages it rewrote. The ASCII grid behind it is a
 * canvas; until the canvas draws, `.axart__still` shows the same still grid.
 */
export function AgentArt() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const core = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!canvas.current) return
    const stop = attachAsciiGrid(canvas.current, core.current)
    setLive(true)
    return stop
  }, [])

  return (
    <>
      <Hr label="00 / AGENT" />
      <section className="col" aria-label="How Doxabot turns code into docs">
        <figure
          className={live ? "axart axart--live" : "axart"}
          role="img"
          aria-label="Illustration: a pull request changes src/routes/users.ts in a GitHub repository. Doxabot reads the diff, rewrites the two docs pages that the change affects, reuses the other pages, and marks the preview as ready."
        >
          <div className="axart__still" aria-hidden="true" />
          <canvas className="axascii" aria-hidden="true" ref={canvas} />
          <div className="axart__grid">
            <div className="axwin">
              <div className="axwin__bar">
                <span>
                  <GithubIcon size={13} />
                  acme/api
                </span>
                <span className="axwin__k">Repository</span>
              </div>
              <ul className="axtree">
                <li>
                  <span className="dir">src/</span>
                </li>
                <li className="in">
                  <span className="dir">routes/</span>
                </li>
                <li className="in2 hot">
                  <span>users.ts</span>
                  <b>M</b>
                </li>
                <li className="in2">
                  <span>orders.ts</span>
                </li>
                <li className="in">
                  <span className="dir">models/</span>
                </li>
                <li>
                  <span>openapi.yaml</span>
                </li>
                <li>
                  <span>AGENTS.md</span>
                </li>
                <li>
                  <span className="note">.doxa/instructions.md</span>
                </li>
              </ul>
              <div className="axwin__foot">PR #142 · Add pagination to users</div>
            </div>

            <div className="axlink">
              <span className="axlink__run">
                <i />
              </span>
            </div>

            <div className="axcore">
              <div className="axcore__frame" ref={core}>
                <span className="axc axc--tl" />
                <span className="axc axc--tr" />
                <span className="axc axc--bl" />
                <span className="axc axc--br" />
                <span className="axring" />
                <span className="axring axring--in" />
                <span className="axcross" />
                <span className="axsweep" />
                {BLIPS.map((blip) => (
                  <span
                    key={blip.delay}
                    className={blip.lav ? "axblip axblip--lav" : "axblip"}
                    style={{ left: `${blip.left}px`, top: `${blip.top}px`, animationDelay: `${blip.delay}s` }}
                  />
                ))}
                <DoxabotMark className="axmark" width={62} height={90} />
              </div>
              <span className="axcore__name">DOXABOT</span>
              <div className="axsay">
                <span>
                  <span className="dot blink" />
                  Reading the diff
                </span>
                <span>
                  <span className="dot blink" />
                  Rewriting 2 pages
                </span>
                <span>✓ Preview ready</span>
              </div>
            </div>

            <div className="axlink axlink--out">
              <span className="axlink__run">
                <i />
              </span>
            </div>

            <div className="axwin">
              <div className="axwin__bar">
                <span>acme/api docs</span>
                <span className="axwin__k">Preview · PR #142</span>
              </div>
              {PAGES.map((page) => (
                <div key={page.path} className={page.hit ? "axpage axpage--hit" : "axpage"}>
                  <span>{page.path}</span>
                  <span className={page.hit ? "axtag axtag--new" : "axtag axtag--same"}>
                    {page.hit ? "REWRITTEN" : "REUSED"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </figure>
        <div className="axart__credit">
          <span>READS CODE AND PULL REQUESTS · WRITES ONLY A CHECK RUN</span>
          <span>CHANGES LAND ON A DOXA BRANCH, NEVER IN YOUR REPOSITORY</span>
        </div>
      </section>
    </>
  )
}
