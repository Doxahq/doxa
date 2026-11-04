import { ClientPicker } from "~/components/marketing/mcp/client-picker"
import { ClientSetup } from "~/components/marketing/mcp/client-setup"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"
import type { CopyState } from "~/lib/mcp/copied"
import { useMcpClientPicker } from "~/lib/mcp/use-client-picker"

/** Section 01: choose a client and add Doxa. A quiet note says what comes next. */
export function McpConnect({ copyState }: { copyState: CopyState }) {
  const { active, menuOpen, pick, toggleMenu, closeMenu } = useMcpClientPicker(copyState.reset)

  return (
    <section className="col cx" id="connect" aria-labelledby="cx-title">
      <div className="cx__head">
        <h2 className="display cx__title" id="cx-title">
          Connect your agent
          <br />
          <span className="mark">to Doxa</span>
        </h2>
        <p>Pick your client and add Doxa.</p>
      </div>
      <div className="cxset">
        <ClientPicker
          active={active}
          menuOpen={menuOpen}
          onPick={pick}
          onToggleMenu={toggleMenu}
          onCloseMenu={closeMenu}
        />
        <ClientSetup active={active} copyState={copyState} />
        <div className="cxnext">
          <p>
            <b>What happens next:</b> {active.signIn} Pick the projects this agent can use, then click Allow. Every
            publish still waits for your approval. No account yet? <a href={GET_STARTED_URL}>Create one for free</a>.
          </p>
          <a className="btn btn--line btn--sm" href={DOCS_URL}>
            Read the docs ›
          </a>
        </div>
      </div>
    </section>
  )
}
