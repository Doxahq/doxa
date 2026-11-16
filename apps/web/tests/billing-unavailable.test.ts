import { describe, expect, test } from "vitest"

import { billingUnavailableKind } from "~/components/dashboard/billing/billing-unavailable"
import { createApiError } from "~/lib/api-errors"
import { isBillingAccountNotFound, isFinalBillingError } from "~/lib/queries/billing"

const apiBody = (message: string, code?: string) => ({ error: { message, ...(code ? { details: { code } } : {}) } })

describe("a failed billing read", () => {
  test("an API error body is from the API; a non-JSON body (a tunnel's HTML 404) is not", () => {
    expect(createApiError(404, apiBody("Billing account not found.")).fromApi).toBe(true)
    expect(createApiError(404, null).fromApi).toBe(false)
  })

  test("billing off on the server shows 'not available' on both pages", () => {
    const off = createApiError(503, apiBody("Billing is not configured on this server.", "billing_not_configured"))
    expect(billingUnavailableKind(off, "accounts")).toBe("not_configured")
    expect(billingUnavailableKind(off, "account")).toBe("not_configured")
  })

  test("an API 403 or 404 for one account is 'not found'; on the list it means no billing routes", () => {
    for (const status of [403, 404]) {
      const missing = createApiError(status, apiBody("Billing account not found."))
      expect(billingUnavailableKind(missing, "account")).toBe("not_found")
      expect(billingUnavailableKind(missing, "accounts")).toBe("not_configured")
    }
  })

  test("a 404 or 503 that did not come from the API offers Try again, and is retried", () => {
    for (const status of [404, 503]) {
      const proxy = createApiError(status, null)
      expect(billingUnavailableKind(proxy, "accounts")).toBe("failed")
      expect(billingUnavailableKind(proxy, "account")).toBe("failed")
      expect(isBillingAccountNotFound(proxy)).toBe(false)
      expect(isFinalBillingError(proxy)).toBe(false)
    }
  })

  test("a network failure or an API 500 offers Try again", () => {
    expect(billingUnavailableKind(new TypeError("Failed to fetch"), "accounts")).toBe("failed")
    expect(billingUnavailableKind(createApiError(500, apiBody("Internal error.")), "account")).toBe("failed")
  })
})
