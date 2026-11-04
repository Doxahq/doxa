import { useRef } from "react"
import { ClientLogo } from "~/components/marketing/mcp/client-logo"
import { ClientMenu } from "~/components/marketing/mcp/client-menu"
import { ANY_CLIENT, MAIN_CLIENTS, isMoreClient, moreButtonText, type McpClient } from "~/lib/mcp/clients"

interface ClientPickerProps {
  active: McpClient
  menuOpen: boolean
  onPick: (client: McpClient) => void
  onToggleMenu: () => void
  onCloseMenu: () => void
}

/** The client tabs, the "More clients" button and its menu. */
export function ClientPicker({ active, menuOpen, onPick, onToggleMenu, onCloseMenu }: ClientPickerProps) {
  const moreRef = useRef<HTMLButtonElement>(null)
  const inMore = isMoreClient(active.id)
  const more = moreButtonText(active)

  const closeMenu = () => {
    onCloseMenu()
    moreRef.current?.focus()
  }

  return (
    <div className="cxtabs-wrap">
      <div className="cxtabs" role="group" aria-label="MCP client">
        {MAIN_CLIENTS.map((c) => {
          const on = c.id === active.id
          return (
            <button
              key={c.id}
              className={on ? "cxtab cxtab--on" : "cxtab"}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(c)}
            >
              <ClientLogo client={c} small />
              {c.label}
            </button>
          )
        })}
        <button
          ref={moreRef}
          className={inMore ? "cxtab cxtab--on" : "cxtab"}
          type="button"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          aria-controls="cxmenu"
          onClick={onToggleMenu}
        >
          {inMore ? <ClientLogo client={active} small /> : null}
          {more.label}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </button>
      </div>
      {menuOpen ? (
        <ClientMenu activeId={active.id} onPick={onPick} onPickAny={() => onPick(ANY_CLIENT)} onClose={closeMenu} />
      ) : null}
    </div>
  )
}
