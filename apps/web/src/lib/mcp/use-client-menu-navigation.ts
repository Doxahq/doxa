import { useEffect, useState, type KeyboardEvent } from "react"

import { ANY_CLIENT, menuGroups, type McpClient } from "~/lib/mcp/clients"

/** The DOM id of a client option, for `aria-activedescendant`. */
export function clientOptionId(clientId: string): string {
  return `mcp-client-option-${clientId}`
}

/**
 * Search and keyboard state for the "More clients" menu, as a combobox: focus
 * stays in the search box, Up and Down move the highlight through the
 * matching clients in list order, and Enter picks the highlighted one. With
 * no match, Enter picks "Any other client". The highlight is kept by id, so
 * it stays on the same client while the search narrows the list, and falls
 * back to the first match when that client is filtered out.
 */
export function useClientMenuNavigation({
  activeId,
  onPick,
}: {
  activeId: string
  onPick: (client: McpClient) => void
}) {
  const [query, setQuery] = useState("")
  const groups = menuGroups(query)
  const options = groups.flatMap((group) => group.clients)
  const [highlightId, setHighlightId] = useState<string | null>(activeId)
  const highlighted = options.find((client) => client.id === highlightId) ?? options[0] ?? null

  useEffect(() => {
    if (!highlighted) return
    document.getElementById(clientOptionId(highlighted.id))?.scrollIntoView({ block: "nearest" })
  }, [highlighted])

  function move(step: 1 | -1) {
    if (options.length === 0) return
    const index = highlighted ? options.indexOf(highlighted) : -1
    const next = options[(index + step + options.length) % options.length]
    setHighlightId(next.id)
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      move(1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      move(-1)
    } else if (event.key === "Enter") {
      event.preventDefault()
      onPick(highlighted ?? ANY_CLIENT)
    }
  }

  return {
    query,
    setQuery,
    groups,
    shown: options.length,
    highlightedId: highlighted?.id ?? null,
    highlight: setHighlightId,
    onSearchKeyDown,
  }
}
