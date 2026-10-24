import { REVIEW_FILES, SAMPLE_DIFF } from "~/lib/marketing/home"

/** Two panes: the code diff that triggers a sync, and the review that gates the publish. */
export function HomeSync() {
  return (
    <section className="col" aria-label="Sync and review">
      <div className="duo">
        <div>
          <div className="duo__top">
            <div>
              <h3>Code changes. Docs follow.</h3>
              <p>The agent reads the diff and finds every page that mentions the changed code.</p>
            </div>
            <a className="btn btn--line btn--sm" href="#">
              Learn more ›
            </a>
          </div>
          <div className="pane">
            <div className="pane__bar">
              <span>SRC/API/USERS.TS</span>
              <span>PR #142</span>
            </div>
            <div className="diff">
              {SAMPLE_DIFF.map((row) => (
                <div className={row.kind} key={row.line}>
                  {row.line}
                </div>
              ))}
            </div>
          </div>
          <div className="pane">
            <div className="pane__bar">
              <span>/DOCS/API/USERS</span>
              <span className="live">
                <span className="dot blink" />
                SYNCED · 41S
              </span>
            </div>
            <div className="rendered">
              <span className="sig">getUsers(limit?)</span>
              <p style={{ color: "#a1a1a1" }}>Returns paginated users from the database.</p>
            </div>
          </div>
        </div>
        <div>
          <div className="duo__top">
            <div>
              <h3>You approve every publish.</h3>
              <p>Rewrites land on a branch with a preview. Nothing goes live until you say so.</p>
            </div>
            <a className="btn btn--line btn--sm" href="#">
              Learn more ›
            </a>
          </div>
          <div className="review">
            <div className="review__row head">
              REVIEW · DOXA/SYNC-142<span className="n">3 PAGES</span>
            </div>
            {REVIEW_FILES.map((file) => (
              <div className="review__row" key={file.path}>
                {file.path}
                <span className="n">
                  <span className="p">+{file.added}</span>
                  {file.removed > 0 ? (
                    <>
                      {" "}
                      <span className="m">−{file.removed}</span>
                    </>
                  ) : null}
                </span>
              </div>
            ))}
            <div className="review__acts">
              <button className="btn btn--line btn--sm" type="button">
                Request changes
              </button>
              <button className="btn btn--light btn--sm" type="button">
                Approve &amp; publish ›
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
