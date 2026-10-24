import { Hr } from "~/components/marketing/guides"
import { SectionHead } from "~/components/marketing/mcp/section-head"
import { TOOL_GROUPS } from "~/lib/marketing/mcp-content"

const PROMPTS = ["write_guide", "update_from_code_change", "review_branch", "fix_broken_links"]
const RESOURCES = ["doxa://reference/mdx", "doxa://schemas/site-config", "doxa://projects/{projectId}/pages/{+href}"]

/** Section 04: every tool by group, plus the server prompts and resources. */
export function McpCatalog() {
  return (
    <>
      <SectionHead
        label="Tool catalog"
        chip="34 tools"
        title={
          <>
            Everything your
            <br />
            agent can do
          </>
        }
        side={
          <div className="stack" style={{ gap: "14px" }}>
            <p>
              Projects, pages, branches, previews, publishing, domains and generation, all from the chat your team
              already uses.
            </p>
            <span className="legend">
              <span className="gate">GATED</span>Requires approval by default
            </span>
          </div>
        }
      />
      <Hr label="04 / TOOLS" />
      <section className="col" aria-label="Tools by group">
        <div className="cat">
          {TOOL_GROUPS.map((g) => (
            <div className="grp" key={g.name}>
              <div className="grp__h">
                {/* The approved design shows the group names as small grey labels (`.grp__h span`). */}
                <h3>
                  <span>{g.name}</span>
                </h3>
                <span>{g.count}</span>
              </div>
              <ul className="tools">
                {g.tools.map((x) => (
                  <li key={x.name}>
                    {x.name}
                    {x.gated ? <span className="gate">GATED</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="extra">
          <div>
            <div className="grp__h">
              <h3>Prompts</h3>
              <span>04</span>
            </div>
            <p>Tested workflows your client can run. Each takes a projectId.</p>
            <ul className="tools">
              {PROMPTS.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="grp__h">
              <h3>Resources</h3>
              <span>03</span>
            </div>
            <p>Reference the agent reads before it writes, so its MDX and settings are right the first time.</p>
            <ul className="tools">
              {RESOURCES.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </>
  )
}
