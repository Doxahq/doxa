// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Command } from "cmdk"
import { Info, PenLine } from "lucide-react"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

const preloadRoute = vi.fn((_options: unknown) => Promise.resolve(undefined))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ preloadRoute }),
}))

import { PreloadHighlightedRow } from "~/components/dashboard/command-menu/command-menu"
import { commandValue, type DashboardCommand } from "~/components/dashboard/command-menu/dashboard-commands"
import { projectsListQueryOptions } from "~/lib/queries/dashboard"

// cmdk scrolls the highlighted row into view. jsdom has no layout.
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
  preloadRoute.mockClear()
})

function pageCommand(id: string, label: string, preload: () => void): DashboardCommand {
  return { id, group: "project", label, icon: id === "content" ? PenLine : Info, run: () => undefined, preload }
}

function renderMenu(commands: DashboardCommand[]) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(projectsListQueryOptions().queryKey, [
    { id: "p2", name: "Flagforge", slug: "flagforge" },
  ] as never)
  return render(
    <QueryClientProvider client={queryClient}>
      <Command label="menu">
        <Command.Input aria-label="search" />
        <Command.List>
          <PreloadHighlightedRow commands={commands} />
          {commands.map((command) => (
            <Command.Item key={command.id} value={commandValue(command)}>
              {command.label}
            </Command.Item>
          ))}
          <Command.Item value="project Flagforge flagforge p2">Flagforge</Command.Item>
        </Command.List>
      </Command>
    </QueryClientProvider>,
  )
}

describe("command menu preload", () => {
  test("each newly highlighted page row preloads that page once", () => {
    const overview = vi.fn()
    const content = vi.fn()
    renderMenu([pageCommand("overview", "Overview", overview), pageCommand("content", "Content", content)])
    // The first row is highlighted when the menu opens.
    expect(overview).toHaveBeenCalledTimes(1)
    expect(content).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByLabelText("search"), { key: "ArrowDown" })
    expect(content).toHaveBeenCalledTimes(1)
    expect(overview).toHaveBeenCalledTimes(1)
  })

  test("a highlighted project row preloads that project", () => {
    renderMenu([pageCommand("overview", "Overview", vi.fn())])
    fireEvent.keyDown(screen.getByLabelText("search"), { key: "ArrowDown" })
    expect(preloadRoute).toHaveBeenCalledWith({ to: "/dashboard/projects/$projectId", params: { projectId: "p2" } })
  })
})
