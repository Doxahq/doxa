import { Link } from "@tanstack/react-router"
import { CLI_COMMANDS, MCP_CLIENTS, PLATFORM_ROWS } from "~/lib/marketing/home"
import { DOCS_URL } from "~/lib/marketing/links"

/** Three product cards: Docs Platform, MCP Server, Doxa CLI. */
export function HomeTrio() {
  return (
    <section className="col" aria-label="Platform, MCP and CLI">
      <div className="trio">
        <div>
          <div className="trio__copy">
            <h3>Docs Platform</h3>
            <p>Branches, previews and edge publishing for MDX, on your own domain.</p>
            <a className="btn btn--line btn--sm" href="#">
              Learn more ›
            </a>
          </div>
          <div className="trio__art">
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
          <div className="trio__copy">
            <h3>MCP Server</h3>
            <p>Edit docs from Claude, Cursor or Codex. Every publish waits for your approval.</p>
            <Link className="btn btn--line btn--sm" to="/mcp">
              Learn more ›
            </Link>
          </div>
          <div className="trio__art">
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
        <div>
          <div className="trio__copy">
            <h3>Doxa CLI</h3>
            <p>Generate and update docs from your terminal, then build the site.</p>
            <a className="btn btn--line btn--sm" href="#">
              Learn more ›
            </a>
          </div>
          <div className="trio__art">
            <div className="cli">
              {CLI_COMMANDS.map((cmd) => (
                <div key={cmd.command}>
                  <code>
                    <span>$</span> {cmd.command}
                  </code>
                  <span>{cmd.note}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
