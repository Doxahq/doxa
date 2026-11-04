import { Hr } from "~/components/marketing/guides"
import { SectionHead } from "~/components/marketing/mcp/section-head"
import { AGENT_STEPS } from "~/lib/marketing/agent"

/** Section 01: the four steps from a repository to reviewed docs. */
export function AgentSteps() {
  return (
    <>
      <Hr label="01 / HOW IT WORKS" />
      <SectionHead
        label="How it works"
        chip="How it works"
        title={
          <>
            From repository
            <br />
            to reviewed docs
          </>
        }
        side={<p>Four steps. You take two of them. Doxabot reads and writes, and you decide what goes live.</p>}
      />
      <Hr />
      <section className="col" aria-label="Steps">
        <div className="axflow">
          <span className="axflow__track" aria-hidden="true" />
          <ol className="axflow__list">
            {AGENT_STEPS.map((step, i) => (
              <li key={step.title} className="axstep">
                <span className="axstep__n">{`0${i + 1}`}</span>
                <span className="axstep__k">{step.who}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  )
}
