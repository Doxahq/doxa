import { Link } from "@tanstack/react-router"
import { MCP_CLIENTS, PLATFORM_ROWS } from "~/lib/marketing/home"
import { DOCS_URL } from "~/lib/marketing/links"

/** Two product cards: Docs Platform and MCP Server. */
export function HomeProductCards() {
  return (
    <section className="col" aria-label="Platform and MCP">
      <div className="products">
        <div>
          <div className="products__copy">
            <h3>Docs Platform</h3>
            <p>Branches, previews and edge publishing for MDX, on your own domain.</p>
            <a className="btn btn--line btn--sm" href={DOCS_URL}>
              Learn more ›
            </a>
          </div>
          <div className="products__art">
            {PLATFORM_ROWS.map((row) => (
              <div className="lrow" key={row.label}>
                <i>{row.icon}</i>
                {row.label}
                <a href={DOCS_URL}>Docs ›</a>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="products__copy">
            <h3>MCP Server</h3>
            <p>Edit docs from Claude, Cursor or Codex. Every publish waits for your approval.</p>
            <Link className="btn btn--line btn--sm" to="/mcp">
              Learn more ›
            </Link>
          </div>
          <div className="products__art">
            <div className="mcpx" aria-hidden="true">
              <div className="mcpx__prompt">
                <span>
                  update the auth guide for v2
                  <span className="caret" />
                </span>
                <b>→</b>
              </div>
              <div className="mcpx__clients">
                {MCP_CLIENTS.map((client) => (
                  <span key={client.name} style={client.delay ? { animationDelay: client.delay } : undefined}>
                    {client.name}
                  </span>
                ))}
              </div>
              <div className="mcpx__status">
                publish → <em>waiting for your approval</em>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
