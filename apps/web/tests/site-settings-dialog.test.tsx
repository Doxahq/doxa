// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import type { BranchRef } from "@doxahq/contracts/docs-branches"
import { FREE_PLAN_ENTITLEMENTS, resolveSiteConfig, type ValidationIssue } from "@doxahq/site-config"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import SiteSettingsDialog from "~/components/dashboard/content/site-settings/site-settings-dialog"
import { DRAFT_AUTOSAVE_DELAY_MS } from "~/lib/dashboard/use-draft-buffer"

const applyProjectContentEdits = vi.fn(async (_projectId: string, _input: unknown) => null)

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  applyProjectContentEdits: (projectId: string, input: unknown) => applyProjectContentEdits(projectId, input),
}))

function overview(): DocsContentOverviewDto {
  return {
    projectId: "project-1",
    projectSlug: "acme",
    siteId: "site-1",
    publishedVersion: { id: "v1", versionNumber: 1, createdAt: "2026-09-24T00:00:00.000Z" },
    working: { branchId: null, baseVersionId: "v1", editedHrefs: [], changeCount: 0, revision: 0, createdAt: null, updatedAt: null, isBaseCurrent: true },
    entitlements: { ...FREE_PLAN_ENTITLEMENTS },
    siteConfig: { published: resolveSiteConfig({ name: "Acme" }), working: null },
    pages: [{ href: "/", title: "Home", sourcePath: "source/index.mdx", status: "published", icon: null }],
    navigation: [],
  }
}

function renderDialog(options: {
  initialServerIssues?: ValidationIssue[]
  branch?: BranchRef
} = {}) {
  const onClose = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  render(
    <SiteSettingsDialog
      projectId="project-1"
      branch={options.branch ?? "main"}
      overview={overview()}
      initialServerIssues={options.initialServerIssues}
      onClose={onClose}
    />,
    { wrapper },
  )
  return { onClose }
}

function tab(name: RegExp) {
  return screen.getByRole("tab", { name })
}

async function openNavbarCta(user: ReturnType<typeof userEvent.setup>) {
  await user.click(tab(/^Navbar/))
  await user.click(screen.getByRole("switch", { name: "Show a call to action button" }))
  return screen.getByLabelText("Button link")
}

describe("site settings dialog", () => {
  beforeEach(() => {
    applyProjectContentEdits.mockClear()
    // Radix and CodeMirror read these browser APIs. jsdom has no layout.
    Element.prototype.scrollIntoView ??= () => undefined
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  test("an invalid link shows its message only after blur, then marks the field and the tab", async () => {
    const user = userEvent.setup()
    renderDialog()
    const href = await openNavbarCta(user)

    await user.clear(href)
    await user.type(href, "javascript:alert(1)")
    // The tab badge counts the error at once. The field waits for the blur.
    expect(tab(/^Navbar/).getAttribute("aria-label")).toBe("Navbar, 1 error")
    expect(href.getAttribute("aria-invalid")).toBe("false")
    expect(screen.queryByText(/This link/)).toBeNull()

    await user.tab()
    const message = await screen.findByText(/This link (is not valid|uses an unsupported protocol)/)
    expect(href.getAttribute("aria-invalid")).toBe("true")
    expect(href.getAttribute("aria-describedby")).toContain(message.closest("ul")?.id)
  })

  test("a new empty link does not raise the summary before the person leaves it", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(tab(/^Navbar/))
    await user.click(screen.getByRole("button", { name: "Add link" }))

    expect(screen.queryByText(/^\d+ errors?/)).toBeNull()
    expect(screen.getByText(/Not saved: correct 2 errors to save\./)).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.getByText(/^2 errors$/)).toBeTruthy()
  })

  test("autosave does not send a config with an error, and the footer says why", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderDialog()
    const href = await openNavbarCta(user)
    await user.clear(href)
    await user.type(href, "not a link")

    await act(async () => vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS * 2))
    expect(applyProjectContentEdits).not.toHaveBeenCalled()
    expect(screen.getByText("Not saved: correct 1 error to save.")).toBeTruthy()
  })

  test("a valid change autosaves with set_site_config", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderDialog()
    const name = screen.getByLabelText("Site name")
    await user.clear(name)
    await user.type(name, "Acme Docs")

    await act(async () => vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS))
    await waitFor(() => expect(applyProjectContentEdits).toHaveBeenCalledTimes(1))
    expect(applyProjectContentEdits.mock.calls[0]?.[1]).toMatchObject({
      branch: "main",
      edits: [{ type: "set_site_config", config: expect.objectContaining({ name: "Acme Docs" }) }],
    })
  })

  test("a settings save targets the selected named branch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const branch = "10000000-0000-4000-8000-000000000001"
    renderDialog({ branch })
    const name = screen.getByLabelText("Site name")
    await user.clear(name)
    await user.type(name, "Branch Docs")

    await act(async () => vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS))
    await waitFor(() => expect(applyProjectContentEdits).toHaveBeenCalledTimes(1))
    expect(applyProjectContentEdits.mock.calls[0]?.[1]).toMatchObject({ branch })
  })

  test("a server issue shows at once on its field and clears when the value changes", async () => {
    const user = userEvent.setup()
    renderDialog({
      initialServerIssues: [
        { path: "/name", code: "too_long", severity: "error", message: "The server rejected this name." },
      ],
    })
    expect(await screen.findAllByText("The server rejected this name.")).not.toHaveLength(0)

    await user.type(screen.getByLabelText("Site name"), "!")
    await waitFor(() => expect(screen.queryByText("The server rejected this name.")).toBeNull())
  })

  test("the free plan cannot hide Powered by Doxa", async () => {
    const user = userEvent.setup()
    renderDialog()
    const toggle = screen.getByRole("switch", { name: "Show 'Powered by Doxa'" })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(toggle.hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("Paid plans")).toBeTruthy()
    await user.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("true")
  })

  test("an invalid theme file lists its issues and changes nothing", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(tab(/^Theme/))
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*=".json"]')
    if (!input) throw new Error("The theme file input is missing.")

    const file = new File([JSON.stringify({ tokens: { light: { background: "url(x)" } } })], "theme.json", {
      type: "application/json",
    })
    await user.upload(input, file)

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText("The theme file was not applied.")).toBeTruthy()
    expect(applyProjectContentEdits).not.toHaveBeenCalled()
    expect(screen.getByText("Every color comes from the preset.")).toBeTruthy()
  })

  test("closing with an unsaved error asks before it drops the changes", async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog()
    const href = await openNavbarCta(user)
    await user.clear(href)
    await user.type(href, "bad link")

    await user.click(screen.getByRole("button", { name: "Done" }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/Close and lose these changes\?/)).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Keep editing" }))
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Done" }))
    await user.click(screen.getByRole("button", { name: "Close without saving" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test("radio groups move with arrow keys and keep one Tab stop", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(tab(/^Theme/))
    const presets = within(screen.getByRole("radiogroup", { name: "Theme preset" })).getAllByRole("radio")
    expect(presets.map((radio) => radio.getAttribute("tabindex"))).toEqual(["0", "-1"])

    presets[0]?.focus()
    await user.keyboard("{ArrowRight}")
    expect(presets[1]?.getAttribute("aria-checked")).toBe("true")
    expect(document.activeElement).toBe(presets[1])
  })

  test("the close question goes away once the errors are corrected", async () => {
    const user = userEvent.setup()
    renderDialog()
    const href = await openNavbarCta(user)
    await user.clear(href)
    await user.type(href, "bad link")
    await user.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.getByText(/Close and lose these changes\?/)).toBeTruthy()

    await user.clear(href)
    await user.type(href, "/")
    await waitFor(() => expect(screen.queryByText(/Close and lose these changes\?/)).toBeNull())
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy()
  })

  test("the summary moves focus to the field of an issue", async () => {
    const user = userEvent.setup()
    renderDialog({
      initialServerIssues: [
        { path: "/navbar/github", code: "invalid_href", severity: "error", message: "Use a full link." },
      ],
    })
    await waitFor(() => expect(document.activeElement?.id).toBe("site-setting:/navbar/github"))

    await user.click(tab(/^Branding/))
    await user.click(screen.getByRole("button", { name: /Navbar · GitHub/ }))
    await waitFor(() => expect(document.activeElement?.id).toBe("site-setting:/navbar/github"))
  })
})
