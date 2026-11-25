// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DOXA_CATALOG } from "@doxahq/billing/catalog"

import { PricingPlans } from "~/components/marketing/pricing/pricing-plans"
import {
  BILLING_OPTIONS,
  COMPARE_ROWS,
  DEFAULT_BILLING,
  FAQ,
  FOUNDER_PRICE_NOTE,
  PLANS,
  upgradeUrl,
} from "~/lib/marketing/pricing"
import { GET_STARTED_URL } from "~/lib/marketing/links"
import { billingQueryKeys } from "~/lib/queries/billing"
import { CLOSED_OFFER, FOUNDER_OFFER } from "./fixtures/billing"

afterEach(cleanup)

const pro = PLANS.find((plan) => plan.id === "pro")!
const compareText = JSON.stringify(COMPARE_ROWS)
const proText = JSON.stringify(pro)

describe("pricing page numbers come from the catalog", () => {
  test("Pro: $99 yearly by default, $129 monthly, −23%", () => {
    expect(DEFAULT_BILLING).toBe("yearly")
    expect(pro.billing?.yearly).toEqual({ price: "$99", per: "/ month", sub: "Billed yearly at $1,188 · cancel anytime" })
    expect(pro.billing?.monthly.price).toBe("$129")
    expect(BILLING_OPTIONS.find((option) => option.id === "yearly")?.note).toBe("−23%")
    expect(DOXA_CATALOG.prices.pro_yearly_founder_v2.amountCents).toBe(118_800)
  })

  test("10,000 credits, pay-as-you-go at $0.01, the metered price, and no old prices", () => {
    expect(proText).toContain("10,000 AI credits / month (included)")
    expect(proText).toContain("$0.01 per credit")
    expect(compareText).toContain("50 + model usage")
    expect(compareText).toContain("20 + model usage")
    expect(compareText).toContain("Pay-as-you-go, $0.01 each")
    for (const old of ["100 + 5 per page", "Packs", "100 credits", "first 100"]) {
      expect(compareText + proText + JSON.stringify(FAQ)).not.toContain(old)
    }
    expect(FOUNDER_PRICE_NOTE).toBe("Founder price for the first 50 paying customers, locked in forever")
  })

  test("the docs chat lines are hidden while chat is planned (D10)", () => {
    expect(DOXA_CATALOG.actions["docs_chat.answer"].status).toBe("planned")
    expect(compareText + proText).not.toMatch(/chat/i)
  })

  test("Upgrade to Pro opens sign-in, then the dashboard Checkout at the interval", () => {
    expect(upgradeUrl("yearly")).toBe(`/signup?redirect=${encodeURIComponent("/dashboard/billing?upgrade=year")}`)
    expect(upgradeUrl("monthly")).toContain(encodeURIComponent("upgrade=month"))
  })
})

function renderPlans(offers: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(billingQueryKeys.offers(), offers)
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
  render(
    <QueryClientProvider client={queryClient}>
      <PricingPlans />
    </QueryClientProvider>,
  )
}

describe("pricing plans with GET /billing/offers", () => {
  afterEach(() => vi.restoreAllMocks())

  test("shows N of 50 founder spots left while the offer is open", async () => {
    renderPlans([FOUNDER_OFFER])
    const card = screen.getByText("PRO").closest(".plan") as HTMLElement
    expect(within(card).getByText("37 of 50 founder spots left · price locked in forever")).toBeTruthy()
    expect(within(card).getByText("$99")).toBeTruthy()
    await userEvent.click(within(card).getByRole("radio", { name: "Monthly" }))
    expect(within(card).getByText("$129")).toBeTruthy()
    expect(within(card).getByRole("link", { name: /Start trial/ }).getAttribute("href")).toBe(upgradeUrl("monthly"))
  })

  test("shows the new price, and no founder line, once the offer is full", () => {
    renderPlans([CLOSED_OFFER])
    const card = screen.getByText("PRO").closest(".plan") as HTMLElement
    expect(within(card).getByText("$169")).toBeTruthy()
    expect(within(card).getByText(/Billed yearly at \$2,028/)).toBeTruthy()
    expect(within(card).queryByText(/founder/i)).toBeNull()
    expect(within(card).getByRole("radio", { name: /Yearly/ }).textContent).toContain("−19%")
  })

  test("without a payment provider (offers answer 503), the catalog prices and today's get-started link", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Payments are not available on this server.", details: { code: "billing_not_configured" } } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    )
    render(
      <QueryClientProvider client={queryClient}>
        <PricingPlans />
      </QueryClientProvider>,
    )
    await vi.waitFor(() => expect(queryClient.getQueryState(billingQueryKeys.offers())?.status).toBe("error"))
    const card = screen.getByText("PRO").closest(".plan") as HTMLElement
    expect(within(card).getByText("$99")).toBeTruthy()
    expect(within(card).getByRole("link", { name: /Start trial/ }).getAttribute("href")).toBe(GET_STARTED_URL)
  })

  test("keeps the trial in the link while the offers load, and when the call fails (network, CORS)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let fail: (error: Error) => void = () => undefined
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((_, reject) => (fail = reject)))
    render(
      <QueryClientProvider client={queryClient}>
        <PricingPlans />
      </QueryClientProvider>,
    )
    const card = screen.getByText("PRO").closest(".plan") as HTMLElement
    const link = () => within(card).getByRole("link", { name: /Start trial/ }).getAttribute("href")
    expect(link()).toBe(upgradeUrl("yearly"))
    fail(new TypeError("Failed to fetch"))
    // The offers query retries a network error once, after about a second.
    await vi.waitFor(() => expect(queryClient.getQueryState(billingQueryKeys.offers())?.status).toBe("error"), { timeout: 3_000 })
    expect(link()).toBe(upgradeUrl("yearly"))
  })
})
