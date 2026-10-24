import { Link } from "@tanstack/react-router"

/** The closing call to action. */
export function McpCta() {
  return (
    <section className="col" aria-label="Get started">
      <div className="cta">
        <h2 className="display">
          Give your agents the docs keys,
          <br />
          <span className="mark">not the publish button</span>
        </h2>
        <div className="row">
          <a className="btn btn--light" href="#connect">
            Connect an agent ›
          </a>
          <Link className="btn btn--line" to="/pricing">
            See pricing ›
          </Link>
        </div>
        <span className="label">Claude · Claude Code · Cursor · VS Code · Codex</span>
      </div>
    </section>
  )
}
