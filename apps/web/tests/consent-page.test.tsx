// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type {
  AgentConsentDecision,
  AgentConsentDetails,
  ApproveAgentConsentInput,
} from "@doxahq/contracts/agent-access"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ConsentPage } from "~/components/oauth/consent-page"
import { ApiRequestError } from "~/lib/api-errors"

const getAgentConsent = vi.fn<(consentId: string) => Promise<AgentConsentDetails>>()
const approveAgentConsent = vi.fn<
  (consentId: string, input: ApproveAgentConsentInput) => Promise<AgentConsentDecision>
>()
const denyAgentConsent = vi.fn<(consentId: string) => Promise<AgentConsentDecision>>()

vi.mock("~/lib/agent-access-api", () => ({
  getAgentConsent: (consentId: string) => getAgentConsent(consentId),
  approveAgentConsent: (consentId: string, input: ApproveAgentConsentInput) =>
    approveAgentConsent(consentId, input),
  denyAgentConsent: (consentId: string) => denyAgentConsent(consentId),
}))

const assign = vi.fn<(url: string) => void>()
const PROJECT_A = "11111111-1111-4111-8111-111111111111"
const PROJECT_B = "22222222-2222-4222-8222-222222222222"

beforeEach(() => {
  getAgentConsent.mockReset()
  approveAgentConsent.mockReset()
  denyAgentConsent.mockReset()
  assign.mockReset()
  vi.stubGlobal("location", { ...window.location, assign })
  approveAgentConsent.mockResolvedValue({ redirectTo: "http://127.0.0.1:3334/callback?code=abc" })
  denyAgentConsent.mockResolvedValue({ redirectTo: "http://127.0.0.1:3334/callback?error=access_denied" })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("consent page", () => {
  test("shows the client identity and the redirect host", async () => {
    getAgentConsent.mockResolvedValue(details())
    renderPage()

    expect(await screen.findByText("Claude Code")).toBeTruthy()
    expect(screen.getByText("verified")).toBeTruthy()
    expect(screen.getByText("claude.ai")).toBeTruthy()
    expect(screen.getByText("127.0.0.1:3334")).toBeTruthy()
    expect(screen.queryByText(/Doxa cannot check this agent/)).toBeNull()
  })

  test("warns about an unverified client", async () => {
    getAgentConsent.mockResolvedValue(details({ verified: false, metadataUrl: null }))
    renderPage()

    expect(await screen.findByText("unverified")).toBeTruthy()
    expect(screen.getByText(/Doxa cannot check this agent/)).toBeTruthy()
  })

  test("an implied scope is checked and cannot be cleared while its write scope is on", async () => {
    getAgentConsent.mockResolvedValue(details())
    const user = userEvent.setup()
    renderPage()

    const read = await screen.findByRole("checkbox", { name: /Read your pages/ })
    const write = screen.getByRole("checkbox", { name: /Create branches and edit pages/ })
    const publish = screen.getByRole("checkbox", { name: /Publish branches/ })
    expect(isChecked(read)).toBe(true)
    expect(isDisabled(read)).toBe(true)

    await user.click(write)
    await user.click(publish)
    expect(isChecked(read)).toBe(true)
    expect(isDisabled(read)).toBe(false)
  })

  test("selected projects need at least one project before Allow works", async () => {
    getAgentConsent.mockResolvedValue(details())
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole("radio", { name: "Selected projects" }))
    const allow = screen.getByRole("button", { name: "Allow" })
    expect(screen.getByText("Choose at least one project.")).toBeTruthy()
    expect(isDisabled(allow)).toBe(true)

    await user.click(screen.getByRole("checkbox", { name: /Beta docs/ }))
    expect(isDisabled(allow)).toBe(false)
    await user.click(allow)

    await waitFor(() => expect(approveAgentConsent).toHaveBeenCalledTimes(1))
    expect(approveAgentConsent).toHaveBeenCalledWith("consent-1", {
      scopes: ["docs:read", "docs:write", "publish"],
      projectScope: { kind: "selected", projectIds: [PROJECT_B] },
    })
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:3334/callback?code=abc"))
  })

  test("Allow with all projects approves every chosen scope", async () => {
    getAgentConsent.mockResolvedValue(details())
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Allow" }))

    await waitFor(() => expect(approveAgentConsent).toHaveBeenCalledWith("consent-1", {
      scopes: ["docs:read", "docs:write", "publish"],
      projectScope: { kind: "all" },
    }))
  })

  test("Deny sends the denial and goes back to the agent", async () => {
    getAgentConsent.mockResolvedValue(details())
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Deny" }))

    await waitFor(() => expect(denyAgentConsent).toHaveBeenCalledWith("consent-1"))
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("http://127.0.0.1:3334/callback?error=access_denied"),
    )
    expect(approveAgentConsent).not.toHaveBeenCalled()
  })

  test("never opens a script URL from the API", async () => {
    getAgentConsent.mockResolvedValue(details())
    denyAgentConsent.mockResolvedValue({ redirectTo: "javascript:alert(1)" })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Deny" }))

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(assign).not.toHaveBeenCalled()
  })

  test("an unknown or expired request shows the expired message", async () => {
    getAgentConsent.mockRejectedValue(new ApiRequestError("Not found", 404, null))
    renderPage()

    expect(
      await screen.findByText("This request expired. Start the connection again from your agent."),
    ).toBeTruthy()
    expect(getAgentConsent).toHaveBeenCalledTimes(1)
  })

  test("a request that expires before the decision shows the expired message", async () => {
    getAgentConsent.mockResolvedValue(details())
    approveAgentConsent.mockRejectedValue(new ApiRequestError("Not found", 404, null))
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Allow" }))

    expect(
      await screen.findByText("This request expired. Start the connection again from your agent."),
    ).toBeTruthy()
    expect(assign).not.toHaveBeenCalled()
  })

  test("a missing consent ID shows the expired message without a request", () => {
    renderPage("")

    expect(
      screen.getByText("This request expired. Start the connection again from your agent."),
    ).toBeTruthy()
    expect(getAgentConsent).not.toHaveBeenCalled()
  })
})

function renderPage(consentId = "consent-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  return render(<ConsentPage consentId={consentId} />, { wrapper: Wrapper })
}

function details(client: Partial<AgentConsentDetails["client"]> = {}): AgentConsentDetails {
  return {
    consentId: "consent-1",
    client: {
      name: "Claude Code",
      metadataUrl: "https://claude.ai/oauth/claude-code-client-metadata",
      verified: true,
      redirectHost: "127.0.0.1:3334",
      ...client,
    },
    requestedScopes: ["docs:write", "publish", "docs:read"],
    projects: [
      { id: PROJECT_A, name: "Alpha docs", slug: "alpha", team: null },
      { id: PROJECT_B, name: "Beta docs", slug: "beta", team: null },
    ],
    expiresAt: "2026-10-04T12:10:00.000Z",
  }
}

function isChecked(element: HTMLElement): boolean {
  return element instanceof HTMLInputElement && element.checked
}

function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled")
}
