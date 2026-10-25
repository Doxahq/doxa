import { useState } from "react"

import { DEFAULT_CLIENT_ID, findClient, type McpClient } from "~/lib/mcp/clients"

/**
 * The chosen MCP client and the "More clients" menu. Every MCP connect UI
 * (the MCP page and the dashboard card) uses it, so they pick clients the
 * same way. `onPick` runs after each pick, for example to reset a "Copied"
 * label.
 */
export function useMcpClientPicker(onPick?: () => void) {
  const [clientId, setClientId] = useState(DEFAULT_CLIENT_ID)
  const [menuOpen, setMenuOpen] = useState(false)

  return {
    active: findClient(clientId),
    menuOpen,
    pick: (client: McpClient) => {
      setClientId(client.id)
      setMenuOpen(false)
      onPick?.()
    },
    toggleMenu: () => setMenuOpen((open) => !open),
    closeMenu: () => setMenuOpen(false),
  }
}

export type McpClientPickerState = ReturnType<typeof useMcpClientPicker>
