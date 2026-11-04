import { useState } from "react"
import { CONTACT_EMAIL, CONTACT_URL } from "~/lib/marketing/links"
import { FAQ } from "~/lib/marketing/pricing"
import { RichText } from "./rich-text"

export function PricingFaq() {
  // The first answer starts open, as in the design.
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
    <section className="col" aria-label="Questions">
      <div className="faq">
        <div className="faq__aside">
          <span className="chip" style={{ width: "fit-content" }}>
            FAQ
          </span>
          <h2 className="display">Questions</h2>
          <p>
            Something not covered here? Write to{" "}
            <a className="faq__mail" href={CONTACT_URL}>
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </div>
        <div className="faq__list">
          {FAQ.map((item, i) => (
            <details key={item.q} open={open.has(i)} onToggle={(e) => toggle(i, e.currentTarget.open)}>
              <summary>{item.q}</summary>
              <p>
                <RichText runs={item.a} />
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
