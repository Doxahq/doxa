import type { ReactNode } from "react"
import { AgentFeature, MockBar } from "~/components/marketing/agent/agent-feature"
import { Hr } from "~/components/marketing/guides"
import { AGENT_FILES } from "~/lib/marketing/agent"

/** The sample `.doxa/instructions.md`, one entry per line. */
const LINES: ReactNode[] = [
  <span className="t-h"># Doxa instructions</span>,
  "",
  <span className="t-h">## Audience</span>,
  "Backend developers who use the Acme API.",
  "",
  <span className="t-h">## Tone</span>,
  "Direct. Short sentences. Show code first.",
  "",
  <span className="t-h">## Terms</span>,
  <>
    <span className="t-p">- </span>Say <span className="t-s">"workspace"</span>, never <span className="t-s">"account"</span>.
  </>,
  "",
  <span className="t-h">## Do not document</span>,
  <>
    <span className="t-p">- </span>src/internal/**
    <span className="caret" />
  </>,
]

/** Section 05: custom instructions, in the dashboard or in the repository. */
export function AgentInstructions() {
  return (
    <>
      <Hr label="05 / INSTRUCTIONS" />
      <AgentFeature
        id="ins-title"
        label="Custom instructions"
        title={
          <>
            Teach it <span className="mark">how your team writes</span>
          </>
        }
        lead="Set the audience, the tone, your terms and your rules once. Doxabot follows them on every run."
        points={[
          {
            icon: "panel",
            title: "In the dashboard",
            body: "Audience, tone, terminology, page types and up to 10 rules. Every change is kept as a version.",
          },
          {
            icon: "file",
            title: "Or in your repository",
            body: (
              <>
                Keep them in <code>.doxa/instructions.md</code>. Doxabot reads it from your default branch.
              </>
            ),
          },
          { icon: "minus", title: "Keep paths out", body: "List the folders Doxabot must never document." },
        ]}
        art={
          <>
            <div className="axpr axedit">
              <MockBar title=".doxa/instructions.md" status="main" />
              <pre>
                {LINES.map((line, i) => (
                  // The lines never move, so the index is a stable key.
                  <div key={i}>{line}</div>
                ))}
              </pre>
            </div>
            <div className="axalso">
              <span className="label">Also reads</span>
              {AGENT_FILES.map((name) => (
                <code key={name}>{name}</code>
              ))}
            </div>
          </>
        }
      />
    </>
  )
}
