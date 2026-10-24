import { ConnectStep } from "~/components/marketing/mcp/connect-step"
import { CopyIcon, InfoIcon } from "~/components/marketing/mcp/copy-icon"
import { SnippetLines } from "~/components/marketing/mcp/snippet-lines"
import type { McpClient } from "~/lib/marketing/mcp"
import type { CopyState } from "~/lib/marketing/mcp-copy"

/** Step 02: the setup snippet of the active client. */
export function StepAdd({ active, copyState }: { active: McpClient; copyState: CopyState }) {
  const { copied, copy } = copyState
  return (
    <ConnectStep n="02" kicker="Add Doxa" title={`Add Doxa to ${active.label}`} lead={active.add}>
      <div className="cxsnip">
        <div className="cxsnip__bar">
          <span className="cxsnip__file">
            <i />
            {active.file}
          </span>
          <button
            className="btn btn--light btn--sm"
            type="button"
            aria-label={`Copy setup for ${active.label}`}
            onClick={() => copy(active.snippet.copy, "snippet")}
          >
            <CopyIcon />
            {copied === "snippet" ? "Copied" : active.copyLabel}
          </button>
        </div>
        <pre>
          <SnippetLines lines={active.snippet.lines} />
        </pre>
        <div className="cxsnip__foot">
          <InfoIcon />
          <span>{active.where}</span>
        </div>
      </div>
    </ConnectStep>
  )
}
