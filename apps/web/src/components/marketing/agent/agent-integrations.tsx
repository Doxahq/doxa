import { Link } from "@tanstack/react-router"
import { GithubIcon } from "~/components/marketing/agent/agent-icons"
import { DoxaMark } from "~/components/marketing/doxa-mark"
import { Hr } from "~/components/marketing/guides"
import { SectionHead } from "~/components/marketing/mcp/section-head"
import { AGENT_PAGE_CLIENTS, GITHUB_PERMISSIONS } from "~/lib/marketing/agent"

/** Section 07: GitHub, the AI tools through MCP, and the docs site. */
export function AgentIntegrations() {
  return (
    <>
      <Hr label="06 / INTEGRATIONS" />
      <SectionHead
        label="Integrations"
        chip="Integrations"
        title={
          <>
            Works where
            <br />
            <span className="mark">your code lives</span>
          </>
        }
        side={
          <p>
            Doxabot starts from GitHub, takes requests from the AI tools your team uses, and publishes to your Doxa docs
            site.
          </p>
        }
      />
      <Hr />
      <section className="col" aria-label="Integrations">
        <div className="axint">
          <div className="axint__c axint__c--main">
            <div className="axint__top">
              <span className="axlogo">
                <GithubIcon size={24} />
              </span>
              <span className="axint__tag">BUILT IN</span>
            </div>
            <h3>GitHub</h3>
            <p>
              The Doxa GitHub App connects your public and private repositories. It reads code and pull requests, and writes one
              check run with the preview link.
            </p>
            <ul className="axint__list">
              {GITHUB_PERMISSIONS.map((permission) => (
                <li key={permission}>{permission}</li>
              ))}
            </ul>
          </div>
          <div className="axint__c">
            <div className="axint__top">
              <span className="axlogos">
                {AGENT_PAGE_CLIENTS.map((client) => (
                  <span key={client.id} className="axlogo">
                    <img src={client.logo} alt={client.label} width={22} height={22} />
                  </span>
                ))}
              </span>
            </div>
            <h3>Your AI tools</h3>
            <p>
              Start, check or cancel a docs generation from Claude, Cursor, VS Code or Codex through the Doxa MCP server.
              A start waits for your approval.
            </p>
            <Link className="btn btn--line btn--sm" to="/mcp">
              MCP server ›
            </Link>
          </div>
          <div className="axint__c">
            <div className="axint__top">
              <span className="axlogo">
                <DoxaMark width={17} height={20} />
              </span>
            </div>
            <h3>Your docs site</h3>
            <p>Publishes to your Doxa site or your own domain. Search, AI chat and llms.txt are built in.</p>
            <Link className="btn btn--line btn--sm" to="/">
              Docs platform ›
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
