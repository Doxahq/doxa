import { AgentFeature, MockBar } from "~/components/marketing/agent/agent-feature"
import { GlobeIcon, TickIcon } from "~/components/marketing/agent/agent-icons"

const DIFF = [
  { kind: "del", line: "- export async function listUsers() {" },
  { kind: "add", line: "+ export async function listUsers(limit = 50) {" },
  { kind: "del", line: "-   return db.users.findMany();" },
  { kind: "add", line: "+   return db.users.findMany({ take: limit });" },
]

/** Section 02: the docs preview check on a pull request. */
export function AgentPullRequest() {
  return (
    <AgentFeature
      id="pr-title"
      label="02 · On every pull request"
      title={
        <>
          Docs review <span className="mark">inside the pull request</span>
        </>
      }
      lead="Open a pull request and Doxabot rewrites only the pages your change touches. A GitHub check links to a live preview of the docs for that branch."
      points={[
        { icon: "check", title: "Only what changed", body: "Pages the change does not touch are reused, not rewritten." },
        {
          icon: "refresh",
          title: "Up to date with each push",
          body: "New commits refresh the preview. Draft pull requests wait until they are ready for review.",
        },
        {
          icon: "list",
          title: "A clear change list",
          body: "The check names the changed sources, the rewritten pages and the reused ones.",
        },
      ]}
      art={
        <>
          <div
            className="axpr"
            role="img"
            aria-label="Illustration: pull request 142, Add pagination to the users API. The Doxa documentation preview check rewrites 2 pages, reuses 14, and links to a live preview of the docs."
          >
            <MockBar title="acme/api · pull request" status="Open" />
            <div className="axpr__head">
              <span className="axpr__title">
                Add pagination to the users API <span>#142</span>
              </span>
              <span className="axpr__meta">
                <span className="axstate">Open</span>
                <span>feat/pagination → main</span>
                <span>· 3 commits</span>
              </span>
            </div>
            <div className="axdiff">
              <div className="axdiff__bar">
                <span>SRC/ROUTES/USERS.TS</span>
                <span>+2 −2</span>
              </div>
              <pre>
                {DIFF.map((row) => (
                  <div key={row.line} className={row.kind}>
                    {row.line}
                  </div>
                ))}
              </pre>
            </div>
            <div className="axchecks">
              <div className="axchecks__k">
                <span>Checks</span>
                <span>2</span>
              </div>
              <div className="axcheck">
                <span className="axok">
                  <TickIcon />
                </span>
                <span className="axcheck__t">
                  <b>ci / test</b>
                  <small>All tests passed</small>
                </span>
                <span className="axcheck__wait">Passed</span>
              </div>
              <div className="axcheck axcheck--doxa">
                <span className="axswap">
                  <span className="axswap__a">
                    <span className="axspin" />
                  </span>
                  <span className="axswap__b axok">
                    <TickIcon />
                  </span>
                </span>
                <span className="axcheck__t">
                  <b>Doxa documentation preview</b>
                  <span className="axswap">
                    <small className="axswap__a">Rewriting pages from this branch…</small>
                    <small className="axswap__b">2 pages rewritten · 14 reused</small>
                  </span>
                </span>
                <span className="axswap">
                  <span className="axswap__a axcheck__wait">Running</span>
                  <span className="axswap__b axcheck__go">Preview ›</span>
                </span>
              </div>
            </div>
          </div>
          <div className="axurl">
            <GlobeIcon />
            Docs preview for PR #142<span>2 pages changed</span>
          </div>
        </>
      }
    />
  )
}
