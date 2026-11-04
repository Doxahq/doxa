import { useEffect, useRef, useState } from "react"

import { attachSolveArt, type SolveArt } from "~/lib/marketing/solve-art"

const MOVES = [
  {
    title: "Read the code",
    text: "Doxabot maps the repository and reads your agent files, like AGENTS.md and CLAUDE.md, before it writes a page.",
  },
  {
    title: "Rewrite what changed",
    text: "A pull request changes code. Doxabot rewrites the pages it touches, and a GitHub check links to the preview.",
  },
  {
    title: "Keep people in charge",
    text: "After the merge, the update waits for review. You accept or reject each page, then publish.",
  },
  {
    title: "Serve people and agents",
    text: "Readers get search and AI chat. Agents get llms.txt and the Doxa MCP server, from the same docs.",
  },
]

const PLAY_PATH = "M0 0 9 5 0 10Z"
const PAUSE_PATH = "M0 0H3V10H0ZM6 0H9V10H6Z"

/** Start the art one screen before the section arrives, so it never draws in view. */
const ATTACH_MARGIN = "100% 0px"

/**
 * Section 01. Two robotic hands solve a cube behind the copy, in plain WebGL2. The
 * art code comes with the page, so nothing more loads, and the art plays by itself
 * and loops. Without WebGL2, the copy stands on the page color. The button stays
 * hidden until the art has drawn, so it never controls art that is not there.
 */
export function AboutSolve() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const art = useRef<SolveArt | null>(null)
  const [playing, setPlaying] = useState<boolean | null>(null)

  const toggle = () => {
    if (!art.current) return
    art.current.setPlaying(!art.current.playing)
    setPlaying(art.current.playing)
  }

  useEffect(() => {
    const surface = canvas.current
    const area = stage.current
    if (!surface || !area) return
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        near.disconnect()
        art.current = attachSolveArt(surface, area)
        if (art.current) setPlaying(art.current.playing)
      },
      { rootMargin: ATTACH_MARGIN },
    )
    near.observe(surface)
    return () => {
      near.disconnect()
      art.current?.stop()
      art.current = null
    }
  }, [])

  return (
    <section className="ab-solve" aria-label="How we solve docs for the age of AI">
      <canvas ref={canvas} className="ab-solve__art" aria-hidden="true" />
      <div className="ab-solve__scrim" />
      <div className="col">
        <div className="ab-solve__top">
          <div className="ab-solve__copy">
            <span className="label">Docs for the age of AI</span>
            <h2 className="display">
              How we solve
              <br />
              docs for the
              <br />
              <span className="mark">age of AI</span>
            </h2>
            <p>
              AI tools write code faster than any team can document it, and they read your docs to
              decide what to write next. Stale docs used to confuse people. Now they mislead agents
              too.
            </p>
            <p>So we treat docs as a system, not a chore. Each change scrambles something. Doxa solves it, move by move.</p>
          </div>
          <div ref={stage} className="ab-solve__stage">
            <div className="ab-solve__hud" hidden={playing === null}>
              <button type="button" className="btn btn--line btn--sm" onClick={toggle}>
                <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
                  <path fill="currentColor" d={playing ? PAUSE_PATH : PLAY_PATH} />
                </svg>
                {playing ? "Pause" : "Play"}
              </button>
            </div>
          </div>
        </div>
        <ol className="ab-solve__moves">
          {MOVES.map((move, i) => (
            <li className="ab-solve__move" key={move.title}>
              <span className="label">Move {String(i + 1).padStart(2, "0")}</span>
              <h3>{move.title}</h3>
              <p>{move.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
