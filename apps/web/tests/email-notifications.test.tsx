// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { EmailPreferences, EmailUnsubscribeResult } from "@doxahq/contracts/email-preferences"
import { afterEach, describe, expect, test, vi } from "vitest"

import { EmailNotificationsSection } from "~/components/dashboard/settings/email-notifications-section"
import { EmailUnsubscribePage } from "~/components/email/email-unsubscribe-page"

const api = vi.hoisted(() => ({
  getEmailPreferences: vi.fn<() => Promise<EmailPreferences>>(),
  updateEmailPreference: vi.fn<() => Promise<EmailPreferences>>(),
  unsubscribeByLink: vi.fn<() => Promise<EmailUnsubscribeResult>>(),
}))

vi.mock("~/lib/email-preferences-api", () => api)
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/dashboard/settings">{children}</a>,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const ALL_ON: EmailPreferences = {
  preferences: [
    { category: "approvals", enabled: true },
    { category: "generations", enabled: true },
    { category: "domains", enabled: true },
  ],
}

function renderWithQueries(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe("email notifications section", () => {
  test("shows one switch for each category and saves a change", async () => {
    api.getEmailPreferences.mockResolvedValue(ALL_ON)
    api.updateEmailPreference.mockResolvedValue({
      preferences: ALL_ON.preferences.map((p) => (p.category === "generations" ? { ...p, enabled: false } : p)),
    })
    renderWithQueries(<EmailNotificationsSection />)

    const generations = await screen.findByRole("switch", { name: "Generations" })
    expect(screen.getAllByRole("switch")).toHaveLength(3)
    await userEvent.click(generations)

    expect(api.updateEmailPreference).toHaveBeenCalledWith({ category: "generations", enabled: false }, expect.anything())
    await waitFor(() => expect(generations.getAttribute("aria-checked")).toBe("false"))
  })

  test("puts the switch back when the save fails", async () => {
    api.getEmailPreferences.mockResolvedValue(ALL_ON)
    api.updateEmailPreference.mockRejectedValue(new Error("Network down."))
    renderWithQueries(<EmailNotificationsSection />)

    const domains = await screen.findByRole("switch", { name: "Custom domains" })
    await userEvent.click(domains)

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(domains.getAttribute("aria-checked")).toBe("true")
  })
})

describe("unsubscribe page", () => {
  const link = { user: "user-1", category: "approvals", token: "t".repeat(43) }

  test("changes nothing until the person confirms", async () => {
    api.unsubscribeByLink.mockResolvedValue({ category: "approvals", unsubscribed: true })
    renderWithQueries(<EmailUnsubscribePage link={link} />)

    expect(api.unsubscribeByLink).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Unsubscribe" }))

    expect(api.unsubscribeByLink).toHaveBeenCalledWith(link)
    expect(await screen.findByText("Unsubscribed")).toBeTruthy()
  })

  test("explains an incomplete link", () => {
    renderWithQueries(<EmailUnsubscribePage link={{ ...link, category: "marketing" }} />)
    expect(screen.getByText("Link not valid")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).toBeNull()
  })
})
