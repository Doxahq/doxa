import type { ReactNode } from "react"

interface ConnectStepProps {
  n: string
  kicker: string
  title: ReactNode
  children: ReactNode
  /** The text under the title. */
  lead: ReactNode
}

/** One numbered step of the connect console: rail, side copy and main panel. */
export function ConnectStep({ n, kicker, title, lead, children }: ConnectStepProps) {
  return (
    <li className="cxs__step" id={`cx-${Number(n)}`}>
      <div className="cxs__rail" aria-hidden="true">
        <span className="cxs__n">{n}</span>
      </div>
      <div className="cxs__side">
        <span className="cxs__k">{kicker}</span>
        <h3>{title}</h3>
        <p>{lead}</p>
      </div>
      <div className="cxs__main">{children}</div>
    </li>
  )
}
