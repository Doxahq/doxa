import { useState, type KeyboardEvent } from "react"
import { ClientLogo } from "~/components/marketing/mcp/client-logo"
import { menuCountLabel, menuGroups, type McpClient } from "~/lib/mcp/clients"

interface ClientMenuProps {
  activeId: string
  onPick: (client: McpClient) => void
  onPickAny: () => void
  onClose: () => void
}

/** The "More clients" dropdown: search, grouped clients and the server URL fallback. */
export function ClientMenu({ activeId, onPick, onPickAny, onClose }: ClientMenuProps) {
  const [query, setQuery] = useState("")
  const groups = menuGroups(query)
  const shown = groups.reduce((n, g) => n + g.clients.length, 0)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onClose()
  }

  return (
    <div className="cxmenu" id="cxmenu" role="dialog" aria-label="More MCP clients" onKeyDown={onKeyDown}>
      <div className="cxmenu__head">
        <label className="cxmenu__q">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <circle cx="6" cy="6" r="4.2" />
            <path d="m9.2 9.2 3.3 3.3" />
          </svg>
          <input
            type="search"
            placeholder="Search clients"
            aria-label="Search clients"
            autoComplete="off"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="cxmenu__count">{menuCountLabel(query, shown)}</span>
        <button className="cxmenu__x" type="button" aria-label="Close the client list" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="m3 3 6 6M9 3 3 9" />
          </svg>
        </button>
      </div>
      <div className="cxmenu__body">
        {groups.map((g) => (
          <div className="cxmenu__group" key={g.key}>
            <span className="cxmenu__k">{g.name}</span>
            {g.clients.map((c) => {
              const on = c.id === activeId
              return (
                <button
                  key={c.id}
                  className={on ? "cxopt cxopt--on" : "cxopt"}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onPick(c)}
                >
                  <ClientLogo client={c} small />
                  <span className="cxopt__t">
                    <span className="cxopt__name">{c.label}</span>
                    <span className="cxopt__how">{c.how}</span>
                  </span>
                </button>
              )
            })}
          </div>
        ))}
        {shown === 0 ? (
          <p className="cxmenu__empty">
            No client matches “{query}”. Use the server URL below. It works with any client that supports remote MCP
            servers.
          </p>
        ) : null}
      </div>
      <div className="cxmenu__foot">
        <span>
          <b>Not in the list?</b> Any client that supports remote MCP servers can connect.
        </span>
        <button className="btn btn--line btn--sm" type="button" onClick={onPickAny}>
          Use the server URL ›
        </button>
      </div>
    </div>
  )
}
