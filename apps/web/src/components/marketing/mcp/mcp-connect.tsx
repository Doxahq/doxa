import { useState } from "react"
import { ClientPicker } from "~/components/marketing/mcp/client-picker"
import { ConnectStep } from "~/components/marketing/mcp/connect-step"
import { ConnectHelp } from "~/components/marketing/mcp/connect-help"
import { InfoIcon } from "~/components/marketing/mcp/copy-icon"
import { StepAdd } from "~/components/marketing/mcp/step-add"
import { StepCheck } from "~/components/marketing/mcp/step-check"
import { StepFirstTask } from "~/components/marketing/mcp/step-first-task"
import { StepSignIn } from "~/components/marketing/mcp/step-sign-in"
import { GET_STARTED_URL } from "~/lib/marketing/links"
import { DEFAULT_CLIENT_ID, findClient, type McpClient } from "~/lib/marketing/mcp"
import type { CopyState } from "~/lib/marketing/mcp-copy"

const RAIL = ["Choose client", "Add Doxa", "Sign in", "Check", "First task"]

/** Section 01: the connect console, from choosing a client to a first task. */
export function McpConnect({ copyState }: { copyState: CopyState }) {
  const [tab, setTab] = useState(DEFAULT_CLIENT_ID)
  const [menuOpen, setMenuOpen] = useState(false)
  const active = findClient(tab)

  const pick = (client: McpClient) => {
    setTab(client.id)
    setMenuOpen(false)
    copyState.reset()
  }

  return (
    <section className="col cx" id="connect" aria-labelledby="cx-title">
      <div className="cx__glow" aria-hidden="true" />
      <div className="cx__head">
        <span className="chip chip--start">
          <b>START HERE</b>Connect your agent
        </span>
        <h2 className="display cx__title" id="cx-title">
          Connect your agent
          <br />
          <span className="mark">to Doxa</span>
        </h2>
        <p>
          Pick your client, add one URL and sign in. Then your agent can read, edit and preview your docs, and you
          approve what goes live.
        </p>
        <ul className="cx__facts">
          <li>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <rect x="2.5" y="6" width="9" height="6.5" />
              <path d="M4.5 6V4a2.5 2.5 0 0 1 5 0v2" />
            </svg>
            OAuth sign-in
          </li>
          <li>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <circle cx="4.5" cy="7" r="2.5" />
              <path d="M7 7h5.5M10.5 7v2M2 12 12 2" />
            </svg>
            No API keys to paste
          </li>
          <li>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M7 1.5 12 3.5v3.5c0 3-2.2 4.9-5 5.5-2.8-.6-5-2.5-5-5.5V3.5z" />
              <path d="m4.8 7 1.6 1.6 2.8-3" />
            </svg>
            You approve every publish
          </li>
        </ul>
      </div>
      <div className="cxcon">
        <span className="cxc cxc--tl" aria-hidden="true" />
        <span className="cxc cxc--tr" aria-hidden="true" />
        <span className="cxc cxc--bl" aria-hidden="true" />
        <span className="cxc cxc--br" aria-hidden="true" />
        <div className="cxcon__bar" aria-hidden="true">
          <i />
          <i />
          <i />
          <b>doxa · connect an agent</b>
          <span className="cxcon__live">{active.label} · 5 steps</span>
        </div>
        <nav className="cxrail" aria-label="Setup steps">
          {RAIL.map((label, i) => (
            <a href={`#cx-${i + 1}`} key={label}>
              <b>{String(i + 1).padStart(2, "0")}</b>
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="cxpre">
          <span className="cxpre__k">
            <InfoIcon />
            Before you start
          </span>
          <p>
            You need a Doxa account. No docs project yet? Your agent can make one for you with{" "}
            <code>create_project</code>.
          </p>
          <a className="btn btn--line btn--sm" href={GET_STARTED_URL}>
            Create a free account ›
          </a>
        </div>
        <ol className="cxs">
          <ConnectStep
            n="01"
            kicker="Choose client"
            title="Where does your agent run?"
            lead="Pick your client. The next steps change to match it. Doxa works with any client that supports remote MCP servers."
          >
            <ClientPicker
              active={active}
              menuOpen={menuOpen}
              onPick={pick}
              onToggleMenu={() => setMenuOpen((open) => !open)}
              onCloseMenu={() => setMenuOpen(false)}
            />
          </ConnectStep>
          <StepAdd active={active} copyState={copyState} />
          <StepSignIn active={active} />
          <StepCheck active={active} copyState={copyState} />
          <StepFirstTask copyState={copyState} />
        </ol>
        <ConnectHelp />
      </div>
    </section>
  )
}
