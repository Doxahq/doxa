import { ctaClickHandler } from "~/lib/analytics/capture-browser-event"
import { AGENT_DIAGRAM } from "~/lib/marketing/home"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"

/** Doxa Agent: copy on the left, the merge → preview → live diagram on the right. */
export function HomeAgentFeature() {
  return (
    <section className="col" aria-label="Doxa Agent">
      <div className="feature">
        <div className="feature__copy">
          <span className="label">Doxa Agent</span>
          <h3>
            An agent that
            <br />
            <span className="mark">reads every merge</span>
          </h3>
          <p>
            It writes your docs from the repository, then watches each pull request. When code changes, it finds every
            page that mentions it and rewrites them on a preview branch.
          </p>
          <div className="row">
            <a className="btn btn--light" href={GET_STARTED_URL} onClick={ctaClickHandler("home_agent_feature", "get_started")}>
              Start free ›
            </a>
            <a className="btn btn--line" href={DOCS_URL}>
              Learn more ›
            </a>
          </div>
        </div>
        <div className="feature__art vdiv">
          <AgentDiagram />
        </div>
      </div>
    </section>
  )
}

function AgentDiagram() {
  return (
    <div
      className="dia"
      role="img"
      aria-label="Diagram: a merged pull request in your repo flows to the Doxa Agent, which writes a preview branch and then publishes live docs after your approval."
    >
      {AGENT_DIAGRAM.gems.map((style) => (
        <span className="gem" key={style.left} style={style} />
      ))}
      {AGENT_DIAGRAM.arrows.flatMap((arrow) =>
        arrow.legs.map((leg, i) => (
          <div
            className={`ln ln--${leg.dir === "right" ? "h" : "v"}`}
            key={`${leg.style.left}-${leg.style.top}-${leg.dir}`}
            style={leg.style}
          >
            <span
              className={`pulse pulse--${leg.dir} pulse--${i === 0 ? "in" : "out"}`}
              style={{ animationDelay: legDelay(arrow.start, i) }}
            />
          </div>
        )),
      )}
      {AGENT_DIAGRAM.nodes.map((node) => (
        <div className={node.agent ? "node node--agent" : "node"} key={node.title} style={node.style}>
          <strong>
            {node.agent ? <span className="dot breathe" /> : null}
            {node.title}
          </strong>
          <span>{node.detail}</span>
        </div>
      ))}
      {AGENT_DIAGRAM.tags.map((tag) => (
        <span className="tagx" key={tag.label} style={{ left: tag.left, top: tag.top }}>
          {tag.label}
        </span>
      ))}
    </div>
  )
}

// Match the signal keyframes in home.css: a 15s cycle with 2s legs.
const SIGNAL_CYCLE_S = 15
const LEG_S = 2

/** Animation delay that puts leg `index` of an arrow at its start time. Never positive, so no leg waits frozen in place. */
function legDelay(arrowStart: number, index: number) {
  const start = arrowStart + index * LEG_S
  return start === 0 ? "0s" : `${start - SIGNAL_CYCLE_S}s`
}
