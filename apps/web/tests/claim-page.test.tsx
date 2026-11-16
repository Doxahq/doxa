// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentClaimDetails, ApproveAgentClaimInput } from "@doxahq/contracts/agent-access"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ClaimPage } from "~/components/oauth/claim-page"
import { ApiRequestError } from "~/lib/api-errors"
import { claimReturnPath, normalizeUserCode } from "~/lib/oauth/claim-model"

const ATTEMPT = "a".repeat(43)
const openAgentClaim = vi.fn<() => Promise<void>>()
const getAgentClaim = vi.fn<() => Promise<AgentClaimDetails>>()
const approveAgentClaim = vi.fn<(input: ApproveAgentClaimInput) => Promise<void>>()
const denyAgentClaim = vi.fn<() => Promise<void>>()
const navigate = vi.fn()

vi.mock("~/lib/agent-access-api", () => ({
  openAgentClaim: () => openAgentClaim(),
  getAgentClaim: () => getAgentClaim(),
  approveAgentClaim: (input: ApproveAgentClaimInput) => approveAgentClaim(input),
  denyAgentClaim: () => denyAgentClaim(),
}))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))

const details: AgentClaimDetails = {
  clientName: "Claude Code",
  tokenName: "Acme docs (local)",
  requestedScopes: ["docs:read", "docs:write"],
  projects: [],
  loginHint: null,
  accountMatches: true,
  expiresAt: "2026-11-09T12:10:00.000Z",
}

function show(signedIn = true): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  render(<ClaimPage attemptToken={ATTEMPT} signedIn={signedIn} />, { wrapper })
}

beforeEach(() => {
  vi.clearAllMocks()
  openAgentClaim.mockResolvedValue(undefined)
  getAgentClaim.mockResolvedValue(details)
  approveAgentClaim.mockResolvedValue(undefined)
  denyAgentClaim.mockResolvedValue(undefined)
})

afterEach(cleanup)

describe("claim page", () => {
  test("sends a signed-out person to sign in and back to this link", async () => {
    show(false)
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/login",
        search: { redirect: `/oauth/claim?attempt=${ATTEMPT}` },
        replace: true,
      }),
    )
    expect(getAgentClaim).not.toHaveBeenCalled()
  })

  test("says where the code is and warns that the agent chose its own name", async () => {
    show()
    expect(await screen.findByText("Claude Code")).toBeTruthy()
    expect(screen.queryByText("unverified")).toBeNull()
    expect(screen.getByText(/It chose its own name/)).toBeTruthy()
    expect(screen.getByText("Find this code in your agent chat. Doxa does not send it by email.")).toBeTruthy()
  })

  test("enables Allow only with a full code, and sends the choices", async () => {
    const user = userEvent.setup()
    show()
    const code = await screen.findByLabelText("Setup code")
    const allow = screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement
    expect(allow.disabled).toBe(true)

    await user.type(code, "12345")
    expect(allow.disabled).toBe(true)
    await user.type(code, "6")
    await user.click(allow)

    await waitFor(() =>
      expect(approveAgentClaim).toHaveBeenCalledWith({
        attemptToken: ATTEMPT,
        userCode: "123456",
        scopes: ["docs:read", "docs:write"],
        projectScope: { kind: "all" },
      }),
    )
    expect(await screen.findByText("Agent connected")).toBeTruthy()
  })

  test("starts with every requested permission ticked", async () => {
    show()
    await screen.findByLabelText("Setup code")
    for (const checkbox of screen.getAllByRole("checkbox") as HTMLInputElement[]) {
      expect(checkbox.checked).toBe(true)
    }
  })

  test("starts with all projects selected when the person has projects", async () => {
    getAgentClaim.mockResolvedValue({
      ...details,
      projects: [{ id: "project-a", name: "Acme", slug: "acme", team: null }],
    })
    show()
    const all = await screen.findByRole("radio", { name: "All projects, including future projects" })
    expect((all as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole("checkbox", { name: /Acme/ })).toBeNull()
  })

  test("shows the API message for a wrong code and keeps the form", async () => {
    const user = userEvent.setup()
    approveAgentClaim.mockRejectedValue(new ApiRequestError("The setup code is not correct. Attempts left: 4.", 400, null))
    show()
    await user.type(await screen.findByLabelText("Setup code"), "111111")
    await user.click(screen.getByRole("button", { name: "Allow" }))
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The setup code is not correct. Attempts left: 4.")
    expect(screen.getByLabelText("Setup code")).toBeTruthy()
  })

  test("blocks an account that does not match the email from the agent", async () => {
    getAgentClaim.mockResolvedValue({ ...details, loginHint: "owner@doxa.test", accountMatches: false })
    show()
    expect(await screen.findByText("Use a different account")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull()
  })

  test("shows an expired message when the claim is gone", async () => {
    openAgentClaim.mockRejectedValue(new ApiRequestError("Not found", 404, null))
    show()
    expect(await screen.findByText("Setup link expired")).toBeTruthy()
  })
})

describe("claim model", () => {
  test("keeps six digits from a pasted code", () => {
    expect(normalizeUserCode(" 123 456 789")).toBe("123456")
  })

  test("encodes the token in the return path", () => {
    expect(claimReturnPath("a b")).toBe("/oauth/claim?attempt=a%20b")
  })
})
