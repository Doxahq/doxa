import { ArtToggle } from "~/components/marketing/art-toggle"
import { useSolveArt } from "~/lib/marketing/use-solve-art"

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

/**
 * The "How we solve docs" section of the About page, hidden for now by
 * `SHOW_SOLVE_SECTION` in `about-page.tsx`. Two robotic hands solve a cube behind the
 * copy, in plain WebGL2. The art code comes with the page, so nothing more loads, and
 * the art plays by itself and loops. Without WebGL2, the copy stands on the page color. The button stays
 * hidden until the art has drawn, so it never controls art that is not there.
 */
export function AboutSolve() {
  const { canvas, stage, playing, toggle } = useSolveArt()

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
              {playing === null ? null : <ArtToggle playing={playing} onToggle={toggle} />}
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
