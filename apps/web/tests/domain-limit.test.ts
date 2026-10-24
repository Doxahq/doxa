import { describe, expect, test } from "vitest"
import type { DocsDomainDto } from "@doxahq/contracts"

import { hasReachedCustomDomainLimit } from "~/lib/dashboard/domain-limit"

describe("hasReachedCustomDomainLimit", () => {
  test("counts only custom domains", () => {
    const domains = [
      createDomain("managed", "doxa_subdomain"),
      createDomain("custom", "custom_domain"),
    ]

    expect(hasReachedCustomDomainLimit(domains, 1)).toBe(true)
    expect(hasReachedCustomDomainLimit(domains, 2)).toBe(false)
  })

  test("blocks custom domains when the configured limit is zero", () => {
    expect(hasReachedCustomDomainLimit([], 0)).toBe(true)
  })
})

function createDomain(id: string, kind: DocsDomainDto["kind"]): DocsDomainDto {
  return {
    id,
    projectId: "project-1",
    siteId: "site-1",
    hostname: `${id}.example.com`,
    kind,
    status: "active",
    verificationStatus: "verified",
    provider: null,
    providerHostnameId: null,
    providerStatus: null,
    providerSslStatus: null,
    ownershipVerification: null,
    ownershipVerificationHttp: null,
    sslValidationRecords: [],
    dnsRecord: null,
    verificationError: null,
    routingStatus: "healthy",
    routingHttpStatus: 204,
    routingError: null,
    routingCheckedAt: "2026-09-07T00:00:00.000Z",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  }
}
