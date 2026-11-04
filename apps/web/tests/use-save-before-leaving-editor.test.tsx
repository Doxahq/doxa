// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
} from "@tanstack/react-router"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useSaveBeforeLeavingEditor } from "~/lib/dashboard/use-save-before-leaving-editor"

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

const CONTENT = "/dashboard/projects/p1/content"

function setup({
  isDirty = true,
  save = async () => true,
  history = createMemoryHistory({ initialEntries: [CONTENT] }),
}: { isDirty?: boolean; save?: () => Promise<boolean>; history?: RouterHistory } = {}) {
  const saveBuffer = vi.fn(save)
  function Editor() {
    useSaveBeforeLeavingEditor({ projectId: "p1", isDirty, saveBuffer })
    return <p>editor</p>
  }
  const root = createRootRoute({ component: Outlet })
  const routes = [
    createRoute({ getParentRoute: () => root, path: CONTENT, component: Editor }),
    createRoute({ getParentRoute: () => root, path: `${CONTENT}/$`, component: Editor }),
    createRoute({ getParentRoute: () => root, path: "/dashboard/projects/p1/project", component: () => <p>overview</p> }),
    createRoute({ getParentRoute: () => root, path: "/login", component: () => <p>login</p> }),
  ]
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history,
  })
  render(<RouterProvider router={router} />)
  return { router, saveBuffer, go: (href: string) => router.navigate({ href }) }
}

// The router restores scroll after a navigation. jsdom has no scrolling.
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.mocked(toast.error).mockClear()
})

describe("useSaveBeforeLeavingEditor", () => {
  test("saves before it leaves the editor, and waits for the save", async () => {
    let finishSave!: (saved: boolean) => void
    const { saveBuffer, go } = setup({ save: () => new Promise((resolve) => (finishSave = resolve)) })
    await screen.findByText("editor")

    void go("/dashboard/projects/p1/project")
    await waitFor(() => expect(saveBuffer).toHaveBeenCalledTimes(1))
    expect(screen.queryByText("overview")).toBeNull()

    finishSave(true)
    await screen.findByText("overview")
  })

  test("keeps the person in the editor when the save fails", async () => {
    const { router } = setup({ save: async () => false })
    await screen.findByText("editor")

    // A blocked navigation does not resolve, so the test does not wait for it.
    void router.navigate({ href: "/dashboard/projects/p1/project" })

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(screen.getByText("editor")).toBeTruthy()
    expect(router.state.location.pathname).toBe(CONTENT)
  })

  test("does not save on a move between pages of the editor", async () => {
    const { saveBuffer, go } = setup()
    await screen.findByText("editor")

    await go(`${CONTENT}/guide`)

    expect(saveBuffer).not.toHaveBeenCalled()
  })

  test("does not hold a signed-out person in the editor", async () => {
    const { saveBuffer, go } = setup({ save: async () => false })
    await screen.findByText("editor")

    await go("/login")

    await screen.findByText("login")
    expect(saveBuffer).not.toHaveBeenCalled()
  })

  test.each([
    [true, true],
    [false, false],
  ])("with isDirty %s, a closing tab warns: %s", async (isDirty, warns) => {
    // Only a browser history listens for a closing tab.
    window.history.replaceState(null, "", CONTENT)
    const history = createBrowserHistory()
    setup({ isDirty, history })
    await screen.findByText("editor")

    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(warns)
    history.destroy()
  })
})
