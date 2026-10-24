import { ConnectStep } from "~/components/marketing/mcp/connect-step"
import { CopyIcon } from "~/components/marketing/mcp/copy-icon"
import type { McpClient } from "~/lib/marketing/mcp"
import { TEST_PROMPT } from "~/lib/marketing/mcp-content"
import type { CopyState } from "~/lib/marketing/mcp-copy"

/** Step 04: where the connection shows, and a first prompt to test it. */
export function StepCheck({ active, copyState }: { active: McpClient; copyState: CopyState }) {
  const { copied, copy } = copyState
  return (
    <ConnectStep
      n="04"
      kicker="Check"
      title="Check the connection"
      lead="Make sure that the agent can see Doxa before you give it real work."
    >
      <div className="cxcheck">
        <div className="cxcheck__tile">
          <span className="cxprompt__k">In {active.label}</span>
          <p>{active.check}</p>
          <span className="cxok">Doxa connected</span>
        </div>
        <div className="cxsnip">
          <div className="cxsnip__bar">
            <span className="cxsnip__file">
              <i />
              Then ask your agent
            </span>
            <button
              className="btn btn--line btn--sm"
              type="button"
              aria-label="Copy the test prompt"
              onClick={() => copy(TEST_PROMPT, "test")}
            >
              <CopyIcon />
              {copied === "test" ? "Copied" : "Copy prompt"}
            </button>
          </div>
          <pre>
            <div>
              <span className="t-p">{"› "}</span>
              {TEST_PROMPT}
            </div>
            <div />
            <div>
              <span className="t-k">● doxa · list_projects</span>
            </div>
            <div>
              <span className="t-c">{"  └ The projects you picked at sign-in"}</span>
            </div>
          </pre>
        </div>
      </div>
    </ConnectStep>
  )
}
