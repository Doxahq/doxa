import { Hr } from "~/components/marketing/guides"
import { SectionHead } from "~/components/marketing/mcp/section-head"

const ICE = { color: "var(--ice)" }

/** Section 02: an agent session from finding a project to going live. */
export function McpWorkflow() {
  return (
    <>
      <SectionHead
        label="Workflow"
        chip="Workflow"
        title={
          <>
            How an agent
            <br />
            ships a change
          </>
        }
        side={
          <p>The server teaches every agent the same safe path. Changes live on a branch until a person says yes.</p>
        }
      />
      <Hr label="02 / WORKFLOW" />
      <section className="col" aria-label="Agent session">
        <div className="flow">
          <div className="flow__bar">
            <i />
            <i />
            <i />
            {" agent session · doxa mcp"}
            <span>branch: agent-auth-v2</span>
          </div>
          <div className="flow__body">
            <span className="flow__line" aria-hidden="true">
              <i />
            </span>
            <ol className="flow__list">
              <li className="fstep">
                <span className="fstep__n">01</span>
                <div className="fstep__calls">
                  <div>
                    list_projects <em>→</em> get_docs_structure
                  </div>
                </div>
                <p>Finds the project and reads its page tree. On main, reads show the live site.</p>
                <span className="res">→ project found</span>
              </li>
              <li className="fstep">
                <span className="fstep__n">02</span>
                <div className="fstep__calls">
                  <div>
                    create_branch <span>agent-auth-v2</span>
                  </div>
                </div>
                <p>Every change starts on its own branch. Agents never edit main.</p>
                <span className="res">→ branch ready</span>
              </li>
              <li className="fstep">
                <span className="fstep__n">03</span>
                <div className="fstep__calls">
                  <div>
                    read_page <em>→</em> write_page / edit_docs
                  </div>
                  <div>
                    <em>upload_asset for images</em>
                  </div>
                </div>
                <p>
                  Each write sends the revision it read as <code style={ICE}>expectedRevision</code>, so it never
                  overwrites newer work.
                </p>
                <span className="res">→ pages written</span>
              </li>
              <li className="fstep">
                <span className="fstep__n">04</span>
                <div className="fstep__calls">
                  <div>
                    get_branch_diff <em>→</em> build_preview
                  </div>
                </div>
                <p>Checks its own diff, then hands you a preview URL to review.</p>
                <span className="res">→ preview URL</span>
              </li>
              <li className="fstep">
                <span className="fstep__n">05</span>
                <div className="fstep__calls">
                  <div>
                    publish_branch <span>"Auth guide for v2"</span>
                  </div>
                </div>
                <p>
                  Returns an approval link. Clients with MCP Tasks get a task and wait, no polling. Pages with MDX issues
                  block the publish.
                </p>
                <span className="res res--wait">→ approval_required</span>
              </li>
              <li className="fstep fstep--you">
                <span className="fstep__n">06</span>
                <div className="fstep__calls">
                  <div>
                    <span>You approve</span> in the dashboard
                  </div>
                  <div>
                    <em>then</em> delete_branch
                  </div>
                </div>
                <p>The change goes live. The agent cleans up its branch.</p>
                <span className="res res--live">→ live</span>
              </li>
            </ol>
          </div>
        </div>
      </section>
    </>
  )
}
