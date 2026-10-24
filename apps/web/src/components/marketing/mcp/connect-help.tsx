import { DOCS_URL } from "~/lib/marketing/links"

/** The troubleshooting block at the end of the connect console. */
export function ConnectHelp() {
  return (
    <div className="cxhelp">
      <div className="cxhelp__side">
        <span className="cxs__k">Troubleshooting</span>
        <h3>Stuck?</h3>
        <a className="btn btn--light btn--sm" href={DOCS_URL}>
          Read the setup docs ›
        </a>
      </div>
      <ul>
        <li>
          <b>The sign-in page did not open.</b>
          <span>
            Reconnect the Doxa server in your client to start sign-in again. In Claude Code, run <code>/mcp</code>, pick
            doxa and choose Authenticate.
          </span>
        </li>
        <li>
          <b>A project is missing.</b>
          <span>
            The agent sees only the projects you picked. Revoke it in Settings › Connected agents, then connect again and
            pick more.
          </span>
        </li>
        <li>
          <b>A tool asks for a new permission.</b>
          <span>Approve that one scope. Doxa asks only for the scope the tool needs, not the full set again.</span>
        </li>
        <li>
          <b>A publish is waiting.</b>
          <span>
            Open the approval link your agent gives you, or the Approvals page of your project in the dashboard.
          </span>
        </li>
      </ul>
    </div>
  )
}
