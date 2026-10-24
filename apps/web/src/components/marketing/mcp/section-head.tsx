import type { ReactNode } from "react"

/** The chip, display title and lead of a page section. */
export function SectionHead({ label, chip, title, side }: { label: string; chip: string; title: ReactNode; side: ReactNode }) {
  return (
    <section className="col" aria-label={label}>
      <div className="head">
        <div className="stack">
          <span className="chip" style={{ width: "fit-content" }}>
            {chip}
          </span>
          <h2 className="display">{title}</h2>
        </div>
        {side}
      </div>
    </section>
  )
}
