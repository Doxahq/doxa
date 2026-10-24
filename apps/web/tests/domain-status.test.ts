import { describe, expect, test } from "vitest"
import type { DocsDomainDto } from "@doxahq/contracts"

import { getDocsDomainStatus } from "~/lib/dashboard/domain-status"

describe("getDocsDomainStatus", () => {
  test("does not call a domain ready until delivery works", () => {
    const status = getDocsDomainStatus(createDomain({
      verificationStatus: "verified",
      providerStatus: "active",
      providerSslStatus: "active",
      routingStatus: "failed",
      routingHttpStatus: 522,
    }))

    expect(status.overall).toEqual({ label: "Needs attention", tone: "danger" })
    expect(status.stages).toEqual([
      expect.objectContaining({ label: "Hostname", state: "ready" }),
      expect.objectContaining({ label: "TLS", state: "ready" }),
      expect.objectContaining({ label: "Delivery", state: "failed", detail: "HTTP 522" }),
    ])
  })

  test("calls a domain ready only when all three stages pass", () => {
    const status = getDocsDomainStatus(createDomain({
      status: "active",
      verificationStatus: "verified",
      providerStatus: "active",
      providerSslStatus: "active",
      routingStatus: "healthy",
      routingHttpStatus: 307,
    }))

    expect(status.overall).toEqual({ label: "Ready", tone: "success" })
    expect(status.stages.map((stage) => stage.state)).toEqual(["ready", "ready", "ready"])
    expect(status.stages.find((stage) => stage.label === "Delivery")?.detail).toBe("Responding")
  })

  test("keeps an active hostname separate from a failed certificate", () => {
    const status = getDocsDomainStatus(createDomain({
      verificationStatus: "failed",
      providerStatus: "active",
      providerSslStatus: "validation_timed_out",
      verificationError: "Certificate validation timed out.",
    }))

    expect(status.stages).toEqual([
      expect.objectContaining({ label: "Hostname", state: "ready" }),
      expect.objectContaining({ label: "TLS", state: "failed" }),
      expect.objectContaining({ label: "Delivery", state: "checking" }),
    ])
    expect(status.summary).toContain("certificate check")
  })
})

function createDomain(overrides: Partial<DocsDomainDto> = {}): DocsDomainDto {
  return {
    id: "domain-1",
    projectId: "project-1",
    siteId: "site-1",
    hostname: "docs.example.com",
    kind: "custom_domain",
    status: "active",
    verificationStatus: "pending",
    provider: "cloudflare",
    providerHostnameId: "hostname-1",
    providerStatus: "pending",
    providerSslStatus: "pending_validation",
    ownershipVerification: null,
    ownershipVerificationHttp: null,
    sslValidationRecords: [],
    dnsRecord: null,
    verificationError: null,
    routingStatus: "pending",
    routingHttpStatus: null,
    routingError: null,
    routingCheckedAt: null,
    createdAt: "2026-08-30T17:00:00.000Z",
    updatedAt: "2026-08-30T17:00:00.000Z",
    ...overrides,
  }
}
