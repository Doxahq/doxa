import { Hr } from "~/components/marketing/guides"
import { COMPARE_ROWS, type CompareCell } from "~/lib/marketing/pricing"

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
            All plans include the docs platform and the MCP server. Paid plans add the Doxa Agent, raise the limits
            and remove the Doxa badge.
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
              <div className="ent" role="columnheader">
                ENTERPRISE
              </div>
            </div>
            {COMPARE_ROWS.map((row) =>
              row.kind === "group" ? (
                <div key={row.label} className="tr tr--group" role="row">
                  <div role="cell">{row.label}</div>
                  <div role="cell" />
                  <div className="pro" role="cell" />
                  <div className="ent" role="cell" />
                </div>
              ) : (
                <div key={row.label} className="tr" role="row">
                  <div role="cell">{row.label}</div>
                  <div role="cell">
                    <Cell cell={row.free} />
                  </div>
                  <div className="pro" role="cell">
                    <Cell cell={row.pro} />
                  </div>
                  <div className="ent" role="cell">
                    <Cell cell={row.enterprise} />
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

/** A check renders as an SVG, so it reads as "included" at a glance. */
function Cell({ cell }: { cell: CompareCell }) {
  if (cell.cls === "yes") {
    return (
      <span className="yes" role="img" aria-label="Included">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8.5l2.5 2.5L12 5.5" />
        </svg>
      </span>
    )
  }
  if (cell.cls === "no") {
    return (
      <span className="no" role="img" aria-label="Not included">
        {cell.t}
      </span>
    )
  }
  return <span className={cell.cls}>{cell.t}</span>
}
