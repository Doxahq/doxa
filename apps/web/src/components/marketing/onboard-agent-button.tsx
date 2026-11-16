import { CopyIcon } from "~/components/marketing/mcp/copy-icon"
import { AGENT_SETUP_PROMPT } from "~/lib/marketing/links"
import { useCopied } from "~/lib/mcp/copied"

const COPY_KEY = "agent-prompt"

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M2 7.5l3.2 3.2L12 3.8" />
    </svg>
  )
}

/**
 * "Onboard your agent": copies the one-line setup prompt, which the visitor pastes into
 * their agent. The agent then signs them up and connects to Doxa through auth.md.
 */
export function OnboardAgentButton({ className }: { className?: string }) {
  const { copied, copy } = useCopied()
  const done = copied === COPY_KEY

  return (
    <button
      type="button"
      className={`agent-cta${done ? " is-copied" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => copy(AGENT_SETUP_PROMPT, COPY_KEY)}
      title={AGENT_SETUP_PROMPT}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{done ? "Prompt copied" : "Onboard your agent"}</span>
    </button>
  )
}
