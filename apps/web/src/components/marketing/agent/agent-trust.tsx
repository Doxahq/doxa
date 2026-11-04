import type { ReactNode } from "react"
import { BranchIcon, EyeIcon, NoTrainIcon, ShieldIcon } from "~/components/marketing/agent/agent-icons"
import { Hr } from "~/components/marketing/guides"
import { SectionHead } from "~/components/marketing/mcp/section-head"

const FACTS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <EyeIcon size={18} />,
    title: "Read-only access",
    body: "The GitHub App reads code and pull requests. It never pushes a commit.",
  },
  {
    icon: <BranchIcon size={18} />,
    title: "Changes on branches",
    body: "Updates go to branches inside Doxa. Your live site does not change until you publish.",
  },
  {
    icon: <ShieldIcon size={18} />,
    title: "You approve",
    body: "Every update after the first waits in a review. You choose each page.",
  },
  {
    icon: <NoTrainIcon />,
    title: "No training on your code",
    body: "We do not use your code or your docs to train AI models.",
  },
]

/** Section 08: what Doxabot can and cannot do. */
export function AgentTrust() {
  return (
    <>
      <Hr label="07 / TRUST" />
      <SectionHead
        label="Built for trust"
        chip="Built for trust"
        title={
          <>
            Your code stays
            <br />
            yours
          </>
        }
        side={<p>Doxabot can read. Only you can publish.</p>}
      />
      <Hr />
      <section className="col" aria-label="Safety facts">
        <div className="axw">
          {FACTS.map((fact) => (
            <div key={fact.title} className="axw__c">
              {fact.icon}
              <h3>{fact.title}</h3>
              <p>{fact.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
