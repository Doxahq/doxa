import { ConnectStep } from "~/components/marketing/mcp/connect-step"
import { ConsentMock } from "~/components/marketing/mcp/consent-mock"
import type { McpClient } from "~/lib/marketing/mcp"

/** Step 03: the OAuth consent screen and what happens on it. */
export function StepSignIn({ active }: { active: McpClient }) {
  return (
    <ConnectStep
      n="03"
      kicker="Sign in"
      title="Sign in and pick projects"
      lead="Doxa uses OAuth. You sign in once in your browser and choose what the agent can reach."
    >
      <div className="cxconsent">
        <ConsentMock active={active} />
        <ol className="cxnotes">
          <li>
            <span className="cxnotes__l">A</span>
            <div>
              <b>Your browser opens.</b> {active.signIn}
            </div>
          </li>
          <li>
            <span className="cxnotes__l">B</span>
            <div>
              <b>Pick projects.</b> Choose the projects this agent can use, or select all projects.
            </div>
          </li>
          <li>
            <span className="cxnotes__l">C</span>
            <div>
              <b>Allow.</b> {active.label} is now connected. Publishes still wait for your approval.
            </div>
          </li>
          <li>
            <span className="cxnotes__l">D</span>
            <div>
              <b>Change your mind?</b> Revoke the agent any time in Settings › Connected agents.
            </div>
          </li>
        </ol>
      </div>
    </ConnectStep>
  )
}
