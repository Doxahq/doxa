import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { Hr } from "~/components/marketing/guides"
import { AGENT_FAQ, type AgentFaqRun } from "~/lib/marketing/agent"
import { CONTACT_EMAIL, CONTACT_URL } from "~/lib/marketing/links"

function Answer({ runs }: { runs: AgentFaqRun[] }) {
  return runs.map((run, i) => {
    if (typeof run === "string") return run
    if ("ph" in run) {
      return (
        <span key={i} className="ph">
          {run.ph}
        </span>
      )
    }
    return (
      <Link key={i} className="faq__link" to={run.to}>
        {run.link}
      </Link>
    )
  })
}

/** Section 09: questions about Doxabot. The first answer starts open. */
export function AgentFaq() {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set([0]))

  const toggle = (index: number, isOpen: boolean) => {
    setOpen((prev) => {
      if (prev.has(index) === isOpen) return prev
      const next = new Set(prev)
      if (isOpen) next.add(index)
      else next.delete(index)
      return next
    })
  }

  return (
    <>
      <Hr label="08 / FAQ" />
      <section className="col" aria-labelledby="faq-title">
        <div className="faq">
          <div className="faq__aside">
            <span className="chip" style={{ width: "fit-content" }}>
              FAQ
            </span>
            <h2 className="display" id="faq-title">
              Questions
            </h2>
            <p>
              Something not covered here? Write to <a href={CONTACT_URL}>{CONTACT_EMAIL}</a>.
            </p>
          </div>
          <div className="faq__list">
            {AGENT_FAQ.map((item, i) => (
              <details key={item.q} open={open.has(i)} onToggle={(e) => toggle(i, e.currentTarget.open)}>
                <summary>{item.q}</summary>
                <p>
                  <Answer runs={item.a} />
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
