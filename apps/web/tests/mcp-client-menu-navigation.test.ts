// @vitest-environment jsdom
import type { KeyboardEvent } from "react"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

import { ANY_CLIENT, MORE_CLIENTS } from "~/lib/mcp/clients"
import { useClientMenuNavigation } from "~/lib/mcp/use-client-menu-navigation"

function press(key: string) {
  return { key, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLInputElement>
}

function setup(activeId = "claude-code") {
  const onPick = vi.fn()
  const hook = renderHook(() => useClientMenuNavigation({ activeId, onPick }))
  return { hook, onPick }
}

describe("MCP client menu keyboard", () => {
  test("starts on the first client, and on the chosen one when it is in the menu", () => {
    expect(setup().hook.result.current.highlightedId).toBe(MORE_CLIENTS[0].id)
    expect(setup("zed").hook.result.current.highlightedId).toBe("zed")
  })

  test("Down and Up move through the clients and wrap", () => {
    const { hook } = setup()
    act(() => hook.result.current.onSearchKeyDown(press("ArrowDown")))
    expect(hook.result.current.highlightedId).toBe(MORE_CLIENTS[1].id)
    act(() => hook.result.current.onSearchKeyDown(press("ArrowUp")))
    act(() => hook.result.current.onSearchKeyDown(press("ArrowUp")))
    expect(hook.result.current.highlightedId).toBe(MORE_CLIENTS.at(-1)?.id)
  })

  test("Enter picks the highlighted client, and the first match after a search", () => {
    const { hook, onPick } = setup()
    act(() => hook.result.current.setQuery("le cha"))
    act(() => hook.result.current.onSearchKeyDown(press("Enter")))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "lechat" }))
  })

  test("Enter with no match picks any other client", () => {
    const { hook, onPick } = setup()
    act(() => hook.result.current.setQuery("no such client"))
    act(() => hook.result.current.onSearchKeyDown(press("Enter")))
    expect(onPick).toHaveBeenCalledWith(ANY_CLIENT)
  })
})
