import { AGENT_LOGOS } from "~/lib/marketing/home"

/** The "Works with any agent" logo row. */
export function HomeAgents() {
  return (
    <section className="col" aria-label="Works with any agent">
      <div className="works">
        <div className="works__label">
          <span className="label">Works with any agent</span>
        </div>
        <div className="works__grid">
          {AGENT_LOGOS.map((agent) => (
            <span className="wk" key={agent.name}>
              <img src={agent.logo} alt="" width="22" height="22" />
              {agent.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
