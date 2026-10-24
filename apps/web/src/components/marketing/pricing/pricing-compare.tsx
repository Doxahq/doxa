import { Hr } from "~/components/marketing/guides"
import { COMPARE_ROWS } from "~/lib/marketing/pricing"

export function PricingCompare() {
  return (
    <>
      <section className="col" aria-label="Compare plans">
        <div className="head">
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <span className="chip" style={{ width: "fit-content" }}>
              Compare
            </span>
            <h2 className="display">
              Every plan,
              <br />
              side by side
            </h2>
          </div>
          <p>
            All plans include the agent, the docs platform and the MCP server. Paid plans raise the limits and remove
            the Doxa badge.
          </p>
        </div>
      </section>
      <Hr label="02 / COMPARE" />
      <section className="col" aria-label="Plan comparison">
        <div className="table" role="table" aria-label="Plan comparison">
          <div className="tbl">
            <div className="tr tr--head" role="row">
              <div role="columnheader">Feature</div>
              <div role="columnheader">FREE</div>
              <div className="pro" role="columnheader">
                PRO
              </div>
              <div role="columnheader">ENTERPRISE</div>
            </div>
            {COMPARE_ROWS.map((row) =>
              row.kind === "group" ? (
                <div key={row.label} className="tr tr--group" role="row">
                  <div role="cell">{row.label}</div>
                  <div role="cell" />
                  <div className="pro" role="cell" />
                  <div role="cell" />
                </div>
              ) : (
                <div key={row.label} className="tr" role="row">
                  <div role="cell">{row.label}</div>
                  <div className={row.free.cls} role="cell">
                    {row.free.t}
                  </div>
                  <div className="pro" role="cell">
                    <span className={row.pro.cls}>{row.pro.t}</span>
                  </div>
                  <div className={row.enterprise.cls} role="cell">
                    {row.enterprise.t}
                  </div>
                </div>
              ),
            )}
          </div>
        </div>
      </section>
    </>
  )
}
