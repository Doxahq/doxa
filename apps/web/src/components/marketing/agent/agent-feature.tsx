import type { ReactNode } from "react"
import { ListIcon, type ListIconName } from "~/components/marketing/agent/agent-icons"

export interface FeaturePoint {
  icon: ListIconName
  title: string
  body: ReactNode
}

/**
 * A feature row: copy with a list of points beside an illustration. `flip`
 * puts the illustration on the left.
 */
export function AgentFeature({
  id,
  label,
  title,
  lead,
  points,
  art,
  artLabel,
  flip = false,
  children,
}: {
  id: string
  label: string
  title: ReactNode
  lead: ReactNode
  points: FeaturePoint[]
  art: ReactNode
  /** Describes the illustration when it is one picture, not readable parts. */
  artLabel?: string
  flip?: boolean
  children?: ReactNode
}) {
  return (
    <section className="col" aria-labelledby={id}>
      <div className={flip ? "axfeat axfeat--flip" : "axfeat"}>
        <div className="axfeat__copy">
          <span className="label">{label}</span>
          <h2 className="display" id={id}>
            {title}
          </h2>
          <p>{lead}</p>
          <ul className="axlist">
            {points.map((point) => (
              <li key={point.title}>
                <span className="axlist__i">
                  <ListIcon name={point.icon} />
                </span>
                <div>
                  <b>{point.title}</b>
                  <span>{point.body}</span>
                </div>
              </li>
            ))}
          </ul>
          {children}
        </div>
        <div className="axfeat__art vdiv" role={artLabel ? "img" : undefined} aria-label={artLabel}>
          {art}
        </div>
      </div>
    </section>
  )
}

/** The bar on top of each mock window: three squares, a title and a status. */
export function MockBar({ title, status }: { title: string; status: string }) {
  return (
    <div className="axbar">
      <i />
      <i />
      <i />
      <b>{title}</b>
      <em>{status}</em>
    </div>
  )
}
