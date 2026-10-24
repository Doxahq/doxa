import { ClientLogo } from "~/components/marketing/mcp/client-logo"
import { CheckIcon } from "~/components/marketing/mcp/copy-icon"
import { DoxaMark } from "~/components/marketing/doxa-mark"
import type { McpClient } from "~/lib/marketing/mcp"

const PROJECTS = [
  { name: "All projects", on: false },
  { name: "api-docs", on: true },
  { name: "sdk-docs", on: true },
]

const SCOPES = ["projects:read", "docs:read", "docs:write", "publish"]

/** A picture of the Doxa consent screen for the active client. */
export function ConsentMock({ active }: { active: McpClient }) {
  return (
    <div className="cxauth" aria-hidden="true">
      <div className="cxauth__bar">
        <i />
        <i />
        <i />
        <span>Doxa · Sign in</span>
      </div>
      <div className="cxauth__body">
        <div className="cxauth__who">
          <span className="cxauth__pair" aria-hidden="true">
            <ClientLogo client={active} />
            <span className="cxauth__link" />
            <span className="cxauth__logo">
              <DoxaMark />
            </span>
          </span>
          <div>
            <h4>Allow {active.label} to use Doxa?</h4>
            <p>Signed in as you@example.com</p>
          </div>
        </div>
        <div>
          <span className="cxauth__k">Projects it can use</span>
          <div className="cxauth__list">
            {PROJECTS.map((p) => (
              <div className="cxauth__row" key={p.name}>
                <span className={p.on ? "cxbox cxbox--on" : "cxbox"}>{p.on ? <CheckIcon hidden={false} /> : null}</span>
                {p.name}
              </div>
            ))}
          </div>
        </div>
        <div>
          <span className="cxauth__k">It asks to</span>
          <div className="cxauth__scopes">
            {SCOPES.map((s) => (
              <span className="cxscope" key={s}>
                {s}
              </span>
            ))}
          </div>
        </div>
        <div className="cxauth__btns">
          <span className="cxfake">Cancel</span>
          <span className="cxfake cxfake--go">Allow</span>
        </div>
      </div>
    </div>
  )
}
