import type { CSSProperties } from "react"

import { ThemedPicture } from "~/components/ui/themed-picture"
import { MCP_ART } from "~/lib/marketing/mcp-art"

const SESSIONS = [
  { client: "Claude Code", tool: "create_branch", arg: "agent-auth-v2" },
  { client: "Cursor", tool: "write_page", arg: "/guides/auth" },
  { client: "Codex", tool: "publish_branch", arg: "→ approval_required", wait: true },
]

// Where the signal leaves the dish, as a share of the image. The blurred
// placeholder fills the box from the first paint, so the animation never runs
// over an empty box. mcp.css picks the placeholder of the page theme.
const ART_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--feed-x": "57.9%",
  "--feed-y": "35.5%",
  "--art-placeholder-dark": `url("${MCP_ART.placeholder.dark}")`,
  "--art-placeholder-light": `url("${MCP_ART.placeholder.light}")`,
}

/** The antenna art with live agent sessions over it. */
export function McpSignal() {
  return (
    <section className="col" aria-label="How agents reach Doxa">
      <div className="art" style={ART_STYLE}>
        <ThemedPicture
          files={MCP_ART.files}
          sizes={MCP_ART.sizes}
          width={MCP_ART.width}
          height={MCP_ART.height}
          fetchPriority="high"
          decoding="async"
          alt="A giant deep-space antenna dish tilts toward the sky. Its base breaks into pixels."
        />
        <div className="art__fx" aria-hidden="true">
          <span className="ring" />
          <span className="ring" />
          <span className="ring" />
          <span className="bus" />
          <span className="stream">
            <i />
            <i />
            <i />
            <i className="back" />
            <i className="back" />
          </span>
          <span className="feed" />
          <div className="sessions">
            {SESSIONS.map((s) => (
              <div className="sess" key={s.client}>
                <div className="sess__head">
                  {s.client}
                  <i />
                </div>
                <div className="sess__line">
                  <b>{s.tool}</b>
                  <span className={s.wait ? "wait" : undefined}>{s.arg}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="art__credit">
        <span>IMAGE · NASA/JPL-CALTECH · GOLDSTONE 70 M ANTENNA (PIA17790)</span>
        <span>STREAMABLE HTTP · OAUTH</span>
      </div>
    </section>
  )
}
