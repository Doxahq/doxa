import { SAMPLE_CODE } from "~/lib/marketing/home"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"

/** "A docs site your team does not maintain." with a sample docs window. */
export function HomeShowcase() {
  return (
    <section className="col" aria-label="The platform">
      <div className="show">
        <div className="show__head">
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <span className="chip" style={{ width: "fit-content" }}>
              The platform
            </span>
            <h2 className="display">
              A docs site your team
              <br />
              does not maintain.
            </h2>
          </div>
          <div className="show__aside">
            <p>
              Every project ships with search, AI chat, versioned branches and previews. Publish to your own domain in
              one click.
            </p>
            <div className="row">
              <a className="btn btn--line btn--sm" href={DOCS_URL}>
                Read the docs ›
              </a>
              <a className="btn btn--light btn--sm" href={GET_STARTED_URL}>
                Start free ›
              </a>
            </div>
          </div>
        </div>
        <div className="stage">
          <DocsWindow />
        </div>
      </div>
    </section>
  )
}

function DocsWindow() {
  return (
    <div className="dwin">
      <div className="dwin__bar">
        <div className="dwin__tabs">
          <strong>acme</strong>
          <span className="on">Documentation</span>
          <span>API Reference</span>
          <span>Changelog</span>
        </div>
        <div className="search">
          Search or ask AI… <kbd>⌘K</kbd>
        </div>
      </div>
      <div className="dwin__body">
        <aside className="sidebar">
          <span className="group">Get started</span>
          <a className="on" href="#">
            Overview
          </a>
          <a href="#">Quickstart</a>
          <a href="#">Authentication</a>
          <span className="group">Payments</span>
          <a href="#">Charges</a>
          <a href="#">Refunds</a>
          <a href="#">Webhooks</a>
        </aside>
        <article className="doc">
          <div className="doc__meta">
            Get started{" "}
            <span className="badge">
              <span className="dot" />
              UPDATED BY AGENT · PR #142
            </span>
          </div>
          <h3>Overview</h3>
          <p>
            The Acme Payments API lets you create charges, issue refunds and listen for events. Every request uses a
            secret key from your dashboard.
          </p>
          <div className="code">{SAMPLE_CODE}</div>
          <div className="doc__cards">
            <a href="#">
              <span>Guide</span>Accept your first payment
            </a>
            <a href="#">
              <span>Reference</span>Refunds API
            </a>
          </div>
        </article>
      </div>
    </div>
  )
}
