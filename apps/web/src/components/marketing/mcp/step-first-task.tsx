import { ConnectStep } from "~/components/marketing/mcp/connect-step"
import { CopyIcon } from "~/components/marketing/mcp/copy-icon"
import { STARTER_PROMPTS } from "~/lib/marketing/mcp-content"
import type { CopyState } from "~/lib/mcp/copied"

/** Step 05: the starter prompts, one per server workflow. */
export function StepFirstTask({ copyState }: { copyState: CopyState }) {
  const { copied, copy } = copyState
  return (
    <ConnectStep
      n="05"
      kicker="First task"
      title="Give it a first task"
      lead="Start from a tested workflow. Each one is a prompt on the Doxa server, so the agent follows the same safe steps every time."
    >
      <div className="cxprompts">
        {STARTER_PROMPTS.map((s, i) => (
          <div className="cxprompt" key={s.name}>
            <span className="cxprompt__k">
              Prompt · <b>{s.name}</b>
            </span>
            <p>“{s.text}”</p>
            <span className="cxprompt__d">{s.desc}</span>
            <button
              className="btn btn--line btn--sm"
              type="button"
              aria-label={`Copy prompt: ${s.text}`}
              onClick={() => copy(s.text, `p${i}`)}
            >
              <CopyIcon />
              {copied === `p${i}` ? "Copied" : "Copy prompt"}
            </button>
          </div>
        ))}
      </div>
    </ConnectStep>
  )
}
