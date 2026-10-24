import { QueryClient } from "@tanstack/react-query"
import { describe, expect, test, vi } from "vitest"
import type { DocsDomainDto } from "@doxahq/contracts"

import { invalidateProjectDomainQueries, removeDomain } from "~/lib/dashboard/cache"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

describe("removeDomain", () => {
  test("removes the deleted domain from cached project domains", () => {
    const first = createDomain("domain-1")
    const second = createDomain("domain-2")

    expect(removeDomain([first, second], "domain-1")).toEqual([second])
  })

  test("handles an empty cache", () => {
    expect(removeDomain(undefined, "domain-1")).toEqual([])
  })

  test("refreshes project links after a domain changes", async () => {
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()

    await invalidateProjectDomainQueries(queryClient, "project-1")

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: dashboardQueryKeys.project("project-1"),
    })
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: dashboardQueryKeys.summary(),
    })
  })
})

function createDomain(id: string): DocsDomainDto {
  return {
    id,
    projectId: "project-1",
    siteId: "site-1",
    hostname: `${id}.example.com`,
    kind: "custom_domain",
    status: "active",
    verificationStatus: "verified",
    provider: "cloudflare",
    providerHostnameId: `provider-${id}`,
    providerStatus: "active",
    providerSslStatus: "active",
    ownershipVerification: null,
    ownershipVerificationHttp: null,
    sslValidationRecords: [],
    dnsRecord: null,
    verificationError: null,
    routingStatus: "healthy",
    routingHttpStatus: 200,
    routingError: null,
    routingCheckedAt: "2026-08-31T10:00:00.000Z",
    createdAt: "2026-08-31T09:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
  }
}
