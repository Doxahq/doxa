import { Hr, Ticks } from "~/components/marketing/guides"
import { CopyIcon } from "~/components/marketing/mcp/copy-icon"
import { SiteNav } from "~/components/marketing/site-nav"
import { DOCS_URL, MCP_SERVER_URL } from "~/lib/marketing/links"
import type { CopyState } from "~/lib/mcp/copied"

export function McpHero({ copyState }: { copyState: CopyState }) {
  const { copied, copy } = copyState
  return (
    <header className="hero">
      <div className="hero__glow" aria-hidden="true" />
      <Ticks side="l" ticks={[{ top: 140 }, { top: 232, left: "38%" }, { top: 330 }, { top: 448, left: "22%" }]} />
      <Ticks side="r" ticks={[{ top: 120 }, { top: 214, right: "30%" }, { top: 306 }, { top: 430, right: "50%" }]} />
      <SiteNav current="mcp" cta={{ label: "Connect an agent ›", href: "#connect" }} />
      <Hr />
      <div className="col">
        <div className="hero__inner">
          <span className="chip">
            <b>NEW</b>MCP Server
          </span>
          <h1 className="display">
            Your agents,
            <br />
            <span className="mark">wired into your docs</span>
          </h1>
          <p>
            Agents in Claude, Cursor or Codex read, edit and preview your docs on a branch. Every publish waits for your
            approval.
          </p>
          <div className="row">
            <a className="btn btn--light" href="#connect">
              Connect an agent ›
            </a>
            <a className="btn btn--line" href={DOCS_URL}>
              Read the MCP docs ›
            </a>
          </div>
          <div className="endpoint">
            <span className="endpoint__k">SERVER URL</span>
            <code className="endpoint__v">{MCP_SERVER_URL}</code>
            <button className="copy" type="button" aria-label="Copy server URL" onClick={() => copy(MCP_SERVER_URL, "url")}>
              <CopyIcon />
              {copied === "url" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}
