import { CopyIcon } from "~/components/marketing/mcp/copy-icon"
import { SnippetLines } from "~/components/mcp/snippet-lines"
import { ANY_CLIENT, type McpClient } from "~/lib/mcp/clients"
import type { CopyState } from "~/lib/mcp/copied"

/** The setup of the chosen client: one short instruction and its snippet. */
export function ClientSetup({ active, copyState }: { active: McpClient; copyState: CopyState }) {
  const { copied, copy } = copyState
  return (
    <div className="cxset__panel">
      <h3>Add Doxa to {active.id === ANY_CLIENT.id ? "your client" : active.label}</h3>
      <p>{active.add}</p>
      <div className="cxsnip">
        <div className="cxsnip__bar">
          <span className="cxsnip__file">{active.file}</span>
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
      </div>
      <small>{active.where}</small>
    </div>
  )
}
