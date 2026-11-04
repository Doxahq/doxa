import { AgentFeature, MockBar } from "~/components/marketing/agent/agent-feature"
import { Hr } from "~/components/marketing/guides"

const REVIEW = [
  {
    file: "api/users.mdx",
    kind: "mod",
    kindLabel: "MODIFIED",
    note: "From src/routes/users.ts, src/models/user.ts",
    accepted: true,
  },
  {
    file: "guides/pagination.mdx",
    kind: "add",
    kindLabel: "ADDED",
    note: "From src/routes/users.ts, openapi.yaml",
    accepted: true,
  },
  {
    file: "guides/legacy-list.mdx",
    kind: "del",
    kindLabel: "REMOVED",
    note: "Rejected: the published page stays",
    accepted: false,
  },
]

/** Section 03: merges wait for a quiet period, then the update waits in a review. */
export function AgentReview() {
  return (
    <>
      <Hr label="03 / REVIEW" />
      <AgentFeature
        flip
        id="review-title"
        label="03 · After the merge"
        title={
          <>
            Nothing goes live <span className="mark">until you say so</span>
          </>
        }
        lead="Merged code starts a docs update on the schedule you pick. The result waits in a review, where you accept or reject each page."
        points={[
          {
            icon: "clock",
            title: "Runs on your schedule",
            body: "After every merge, once merges stop for a quiet period, or only when you start it.",
          },
          { icon: "check", title: "Decide page by page", body: "Reject a page and the published version stays." },
          { icon: "source", title: "See where it came from", body: "Each page lists the source files it was written from." },
          {
            icon: "lock",
            title: "Lock the pages you own",
            body: "A locked page stays as you published it. A backup branch is kept when an update replaces pages your team wrote.",
          },
        ]}
        artLabel="Illustration: two pull requests merge into main. After 30 minutes with no new merges, Doxabot runs once. The review lists three pages: one modified and accepted, one added and accepted, one removal rejected. The button publishes two pages."
        art={
          <>
            <div className="axpr">
              <MockBar title="merges into main" status="Quiet time · 30 min" />
              <div className="axtl__track">
                <span className="axtl__line">
                  <span className="axtl__walk">
                    <i />
                  </span>
                </span>
                <span className="axtl__quiet" style={{ left: "34%", width: "50%" }}>
                  <span>No new merges</span>
                </span>
                <span className="axtl__node axtl__node--a" style={{ left: "8%" }}>
                  <i />
                  <span>#142 merged</span>
                </span>
                <span className="axtl__node axtl__node--b" style={{ left: "30%" }}>
                  <i />
                  <span>#143 merged</span>
                </span>
                <span className="axtl__node axtl__node--run" style={{ left: "91%" }}>
                  <i />
                  <span>Doxabot runs</span>
                </span>
              </div>
            </div>
            <div className="axpr">
              <MockBar title="review · 3 pages" status="Waiting for you" />
              {REVIEW.map((row) => (
                <div key={row.file} className="axrv__row">
                  <span className="axrv__file">
                    <b>
                      {row.file}
                      <span className={`axkind axkind--${row.kind}`}>{row.kindLabel}</span>
                    </b>
                    <small>{row.note}</small>
                  </span>
                  <span className="axseg">
                    <span className={row.accepted ? "yes" : undefined}>Accept</span>
                    <span className={row.accepted ? undefined : "no"}>Reject</span>
                  </span>
                </div>
              ))}
              <div className="axrv__foot">
                <span>2 accepted · 1 rejected</span>
                <span className="axfake">Publish 2 pages ›</span>
              </div>
            </div>
          </>
        }
      />
    </>
  )
}
