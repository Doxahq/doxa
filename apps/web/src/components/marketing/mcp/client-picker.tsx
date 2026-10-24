import { useRef } from "react"
import { ClientLogo } from "~/components/marketing/mcp/client-logo"
import { ClientMenu } from "~/components/marketing/mcp/client-menu"
import { CheckIcon } from "~/components/marketing/mcp/copy-icon"
import { ANY_CLIENT, MAIN_CLIENTS, isMoreClient, moreButtonText, moreStack, type McpClient } from "~/lib/marketing/mcp"

interface ClientPickerProps {
  active: McpClient
  menuOpen: boolean
  onPick: (client: McpClient) => void
  onToggleMenu: () => void
  onCloseMenu: () => void
}

const STACK = moreStack()

/** Step 01: the five client tabs, the "More clients" button and its menu. */
export function ClientPicker({ active, menuOpen, onPick, onToggleMenu, onCloseMenu }: ClientPickerProps) {
  const moreRef = useRef<HTMLButtonElement>(null)
  const inMore = isMoreClient(active.id)
  const more = moreButtonText(active)

  const closeMenu = () => {
    onCloseMenu()
    moreRef.current?.focus()
  }

  return (
    <div className="cxpick-wrap">
      <div className="cxpick-grid" role="group" aria-label="MCP client">
        {MAIN_CLIENTS.map((c) => {
          const on = c.id === active.id
          return (
            <button
              key={c.id}
              className={on ? "cxpick cxpick--on" : "cxpick"}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(c)}
            >
              <span className="cxpick__top">
                <ClientLogo client={c} />
                <span className="cxpick__dot">
                  <CheckIcon />
                </span>
              </span>
              <span className="cxpick__name">{c.label}</span>
              <span className="cxpick__how">
                {c.kind} · {c.how}
              </span>
            </button>
          )
        })}
        <button
          ref={moreRef}
          className={inMore ? "cxpick cxpick--on" : "cxpick"}
          type="button"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          aria-controls="cxmenu"
          onClick={onToggleMenu}
        >
          <span className="cxpick__top">
            {inMore ? (
              <ClientLogo client={active} />
            ) : (
              <span className="cxstack" aria-hidden="true">
                {STACK.logos.map((src) => (
                  <span className="cxlogo cxlogo--sm" key={src}>
                    <img src={src} alt="" width="16" height="16" />
                  </span>
                ))}
                <span className="cxlogo cxlogo--sm cxlogo--n">{STACK.count}</span>
              </span>
            )}
            <span className="cxpick__chev">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" />
              </svg>
            </span>
          </span>
          <span className="cxpick__name">{more.label}</span>
          <span className="cxpick__how">{more.how}</span>
        </button>
      </div>
      {menuOpen ? (
        <ClientMenu activeId={active.id} onPick={onPick} onPickAny={() => onPick(ANY_CLIENT)} onClose={closeMenu} />
      ) : null}
    </div>
  )
}
