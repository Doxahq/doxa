import { Hr } from "~/components/marketing/guides"
import { SectionHead } from "~/components/marketing/mcp/section-head"
import { APPROVAL_DEFAULTS, APPROVAL_MODE_LABEL } from "~/lib/marketing/mcp-content"

const ICE = { color: "#9cc2ff" }

const TOKEN_SCOPES = [
  "projects:read",
  "projects:write",
  "docs:read",
  "docs:write",
  "site:write",
  "domains:write",
  "publish",
  "generation:run",
]

const ICON = { width: 18, height: 18, viewBox: "0 0 18 18", fill: "none", stroke: "currentColor", strokeWidth: 1.4 } as const

/** Section 03: approval defaults, the three modes and the safety facts. */
export function McpSafety() {
  return (
    <>
      <Hr label="03 / SAFETY" />
      <SectionHead
        label="Safety"
        chip="Approvals"
        title={
          <>
            Built for
            <br />
            <span className="mark">safe hands</span>
          </>
        }
        side={
          <p>
            Risky actions stop and wait for a person. You choose the rule for each action, per project or for your own
            agents.
          </p>
        }
      />
      <Hr />
      <section className="col" aria-label="Approval defaults">
        <div className="safe">
          <div className="atbl" role="table" aria-label="Default approval mode per action">
            <div className="arow arow--head" role="row">
              <span role="columnheader">Action</span>
              <span role="columnheader">Default</span>
            </div>
            {APPROVAL_DEFAULTS.map((a) => (
              <div className="arow" role="row" key={a.title}>
                <span role="cell">
                  {a.title}
                  {a.note ? <small>{a.note}</small> : null}
                </span>
                <span role="cell">
                  <span className={`mode mode--${a.mode}`}>
                    <i />
                    {APPROVAL_MODE_LABEL[a.mode]}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className="modes">
            <h3>Three modes</h3>
            <p>Every action an agent can take through the gate runs in one of three modes.</p>
            <div className="mrow">
              <span className="mode mode--allow">
                <i />
                Allow
              </span>
              <p>The action runs at once.</p>
            </div>
            <div className="mrow">
              <span className="mode mode--req">
                <i />
                Require approval
              </span>
              <p>The agent gets an approval link. The action runs only after a person approves it in the dashboard.</p>
            </div>
            <div className="mrow">
              <span className="mode mode--deny">
                <i />
                Deny
              </span>
              <p>The agent can never run the action.</p>
            </div>
          </div>
        </div>
        <div className="facts">
          <div className="fact">
            <svg {...ICON} aria-hidden="true">
              <rect x="3" y="3" width="12" height="12" />
              <path d="M6 6l6 6M12 6l-6 6" />
            </svg>
            <h3>Agents can never approve</h3>
            <p>No OAuth scope grants deciding approvals, setting gates or running the team. A person does that.</p>
          </div>
          <div className="fact">
            <svg {...ICON} aria-hidden="true">
              <rect x="2.5" y="2.5" width="5.5" height="5.5" />
              <rect x="10" y="2.5" width="5.5" height="5.5" />
              <rect x="2.5" y="10" width="5.5" height="5.5" />
              <path d="M11 12.5l1.5 1.5 3-3.5" />
            </svg>
            <h3>Pick projects at consent</h3>
            <p>An agent sees only the projects you choose when you connect it, or all projects if you say so.</p>
          </div>
          <div className="fact fact--wide">
            <svg {...ICON} aria-hidden="true">
              <circle cx="6" cy="9" r="3.5" />
              <path d="M9.5 9H16M13 9v3M15.5 9v2" />
            </svg>
            <h3>Scoped tokens</h3>
            <p>
              Each connection holds only the scopes it needs. <code style={ICE}>publish</code> also grants{" "}
              <code style={ICE}>docs:read</code>.
            </p>
            <div className="scopes">
              {TOKEN_SCOPES.map((s) => (
                <span className="scope" key={s}>
                  {s}
                </span>
              ))}
            </div>
          </div>
          <div className="fact">
            <svg {...ICON} aria-hidden="true">
              <path d="M3 14h4v-4h4V6h4" />
              <path d="M13 4l2 2-2 2" />
            </svg>
            <h3>Step-up, not start-over</h3>
            <p>A tool that needs a new scope asks for that one scope only. You approve it once.</p>
          </div>
          <div className="fact">
            <svg {...ICON} aria-hidden="true">
              <circle cx="5" cy="4" r="1.8" />
              <circle cx="5" cy="14" r="1.8" />
              <circle cx="13" cy="7" r="1.8" />
              <path d="M5 5.8v6.4M13 8.8c0 2.5-3 2.5-6.5 4" />
            </svg>
            <h3>Branch-only edits</h3>
            <p>
              Agents work on <code style={ICE}>agent-*</code> branches. Main stays live and untouched.
            </p>
          </div>
          <div className="fact">
            <svg {...ICON} aria-hidden="true">
              <path d="M7 4H3v11h11v-4" />
              <path d="M10 3h5v5M15 3l-7 7" />
            </svg>
            <h3>Revoke any time</h3>
            <p>See every connected agent in Settings › Connected agents and cut one off in a click.</p>
          </div>
          <div className="fact">
            <svg {...ICON} aria-hidden="true">
              <circle cx="6.5" cy="6" r="2.5" />
              <circle cx="12.5" cy="7" r="2" />
              <path d="M2 15c.5-3 2.3-4.5 4.5-4.5S10.5 12 11 15M11.5 11c2 0 3.6 1.2 4.5 3.5" />
            </svg>
            <h3>Teams ready</h3>
            <p>One option stops a member from approving a request that their own agent made.</p>
          </div>
        </div>
      </section>
    </>
  )
}
