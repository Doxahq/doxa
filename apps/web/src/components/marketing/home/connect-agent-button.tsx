import { ctaClickHandler } from "~/lib/analytics/capture-browser-event"
import { AGENT_SETUP_PROMPT } from "~/lib/marketing/links"
import { useCopied } from "~/lib/mcp/copied"

const COPY_KEY = "agent-prompt"

const AGENTS = [
  { name: "Claude", src: "/marketing/logos/claude.svg" },
  { name: "Codex", src: "/marketing/logos/codex.svg" },
  { name: "Cursor", src: "/marketing/logos/cursor.svg" },
] as const

/**
 * "Agent setup" in the home hero, after context.dev: the logos of three agents, then the
 * label. A click copies the one-line setup prompt that the visitor pastes into their agent.
 * `location` names the section for the `cta_clicked` event.
 */
export function ConnectAgentButton({ location }: { location: string }) {
  const { copied, copy } = useCopied()
  const done = copied === COPY_KEY

  return (
    <button
      type="button"
      className={`btn btn--line hero__connect${done ? " is-copied" : ""}`}
      onClick={() => {
        ctaClickHandler(location, "connect_agent")()
        copy(AGENT_SETUP_PROMPT, COPY_KEY)
      }}
      title={AGENT_SETUP_PROMPT}
    >
      <span className="hero__connect-logos" aria-hidden="true">
        {AGENTS.map((agent) => (
          <span className="hero__connect-logo" key={agent.name}>
            <img src={agent.src} alt="" width={14} height={14} />
          </span>
        ))}
      </span>
      <span aria-live="polite">{done ? "Prompt copied ✓" : "Agent setup"}</span>
    </button>
  )
}
