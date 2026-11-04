import { Hr } from "~/components/marketing/guides"
import { CONTACT_EMAIL, CONTACT_URL } from "~/lib/marketing/links"

/** Section 05: questions about the MCP server. */
export function McpFaq() {
  return (
    <>
      <Hr label="05 / FAQ" />
      <section className="col" aria-label="Questions">
        <div className="faq">
          <div className="faq__aside">
            <span className="chip" style={{ width: "fit-content" }}>
              FAQ
            </span>
            <h2 className="display">Questions</h2>
            <p>
              Something not covered here? Write to{" "}
              <a className="faq__mail" href={CONTACT_URL}>
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </div>
          <div className="faq__list">
            <details open>
              <summary>Which clients work with the Doxa MCP server?</summary>
              <p>
                Any client that supports remote MCP servers with OAuth sign-in. That includes Claude, Claude Code,
                Cursor, VS Code and Codex.
              </p>
            </details>
            <details>
              <summary>Can an agent publish on its own?</summary>
              <p>
                Not by default. Publishing a branch requires a person's approval. You can change the mode for each
                action to Allow, Require approval or Deny.
              </p>
            </details>
            <details>
              <summary>What can a connected agent see?</summary>
              <p>Only the projects you pick on the consent screen, and only within the scopes its token holds.</p>
            </details>
            <details>
              <summary>Is the MCP server on the Free plan?</summary>
              <p>
                <span className="ph">[PLAN AVAILABILITY]</span>
              </p>
            </details>
            <details>
              <summary>How do I disconnect an agent?</summary>
              <p>Open Settings › Connected agents in the Doxa dashboard and revoke it. Its access stops at once.</p>
            </details>
            <details>
              <summary>Does it work with self-hosted Doxa?</summary>
              <p>
                <span className="ph">[SELF-HOSTED MCP DETAILS]</span>
              </p>
            </details>
          </div>
        </div>
      </section>
    </>
  )
}
