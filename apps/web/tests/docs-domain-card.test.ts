import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, test, vi } from "vitest"
import type { DocsDomainDto } from "@doxahq/contracts"

import { DocsDomainCard } from "~/components/dashboard/docs-domain-card"

describe("DocsDomainCard", () => {
  test("shows certificate success and delivery failure as separate stages", () => {
    const markup = renderCard({
      domain: createDomain(),
      isChecking: false,
      isDeleting: false,
      onCheck: vi.fn(),
      onDelete: vi.fn(async () => null),
    })

    expect(markup).toContain("Needs attention")
    expect(markup).toContain("Hostname")
    expect(markup).toContain("TLS")
    expect(markup).toContain("Delivery")
    expect(markup).toContain("HTTP 522")
    expect(markup).toContain("Cloudflare reached the custom hostname")
    expect(markup).toContain("Check again")
    expect(markup).toContain("Delete")
  })

  test("keeps DNS setup visible when the API cannot provide a target", () => {
    const markup = renderCard({
      domain: createDomain({
        verificationStatus: "pending",
        providerStatus: "pending",
        providerSslStatus: "pending_validation",
        dnsRecord: null,
        routingStatus: "pending",
        routingHttpStatus: null,
        routingError: null,
        routingCheckedAt: null,
      }),
      isChecking: false,
      isDeleting: false,
      onCheck: vi.fn(),
      onDelete: vi.fn(async () => null),
    })

    expect(markup).toContain("DNS setup")
    expect(markup).toContain("DNS configuration unavailable")
    expect(markup).toContain("Doxa cannot provide the CNAME target for this environment.")
    expect(markup).not.toContain("Detecting your DNS host")
  })

  test("shows complete DNS instructions with copy actions before verification", () => {
    const markup = renderCard({
      domain: createDomain({
        verificationStatus: "pending",
        providerStatus: "pending",
        providerSslStatus: "pending_validation",
        routingStatus: "pending",
        routingHttpStatus: null,
        routingError: null,
        routingCheckedAt: null,
      }),
      isChecking: false,
      isDeleting: false,
      onCheck: vi.fn(),
      onDelete: vi.fn(async () => null),
    })

    expect(markup).toContain("DNS setup")
    expect(markup).toContain("CNAME")
    expect(markup).toContain("docs.example.com")
    expect(markup).toContain("cname.doxa.page")
    expect(markup).toContain('aria-label="Copy DNS name"')
    expect(markup).toContain('aria-label="Copy DNS target"')
    expect(markup).toContain('aria-label="Detecting your DNS host"')
  })

  test("shows only the CNAME record to add, not ownership or HTTP challenge values", () => {
    const markup = renderCard({
      domain: createDomain({
        verificationStatus: "pending",
        providerStatus: "pending",
        providerSslStatus: "pending_validation",
        ownershipVerification: {
          type: "txt",
          name: "_cf-custom-hostname.docs.example.com",
          value: "verification-token",
        },
        ownershipVerificationHttp: {
          url: "http://docs.example.com/.well-known/cf-custom-hostname-challenge/abc",
          body: "challenge-body",
        },
        routingStatus: "pending",
        routingHttpStatus: null,
        routingError: null,
        routingCheckedAt: null,
      }),
      isChecking: false,
      isDeleting: false,
      onCheck: vi.fn(),
      onDelete: vi.fn(async () => null),
    })

    expect(markup).not.toContain("Ownership")
    expect(markup).not.toContain("verification-token")
    expect(markup).not.toContain("HTTP URL")
    expect(markup).not.toContain("cf-custom-hostname-challenge")
    expect(markup).not.toContain("challenge-body")
    expect(markup.match(/class="min-w-0 rounded-md border border-border bg-muted\/10 px-3 py-2"/g)).toHaveLength(3)
  })

  test("replaces certificate challenge details with automatic issuance guidance", () => {
    const markup = renderCard({
      domain: createDomain({
        verificationStatus: "pending",
        providerStatus: "pending",
        providerSslStatus: "pending_validation",
        routingStatus: "pending",
        routingHttpStatus: null,
        routingError: null,
        routingCheckedAt: null,
        sslValidationRecords: [
          {
            status: "pending",
            txtName: null,
            txtValue: null,
            httpUrl: "http://docs.example.com/.well-known/acme-challenge/acme-token",
            httpBody: "acme-token.acme-response",
          },
        ],
      }),
      isChecking: false,
      isDeleting: false,
      onCheck: vi.fn(),
      onDelete: vi.fn(async () => null),
    })

    expect(markup).toContain('aria-label="Automatic certificate issuance"')
    expect(markup).toContain("Doxa issues the SSL certificate automatically after the record works.")
    expect(markup).not.toContain("SSL HTTP URL")
    expect(markup).not.toContain("acme-token")
    expect(markup).not.toContain("acme-response")
  })

  test("hides DNS instructions after hostname and certificate verification", () => {
    const markup = renderCard({
      domain: createDomain(),
      isChecking: false,
      isDeleting: false,
      onCheck: vi.fn(),
      onDelete: vi.fn(async () => null),
    })

    expect(markup).not.toContain("DNS setup")
    expect(markup).not.toContain("cname.doxa.page")
  })
})

/** The DNS host lookup stays pending in a static render, so the steps show their skeleton. */
function renderCard(props: ComponentProps<typeof DocsDomainCard>): string {
  const client = new QueryClient()
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(DocsDomainCard, props)))
}

function createDomain(overrides: Partial<DocsDomainDto> = {}): DocsDomainDto {
  return {
    id: "domain-1",
    projectId: "project-1",
    siteId: "site-1",
    hostname: "docs.example.com",
    kind: "custom_domain",
    status: "active",
    verificationStatus: "verified",
    provider: "cloudflare",
    providerHostnameId: "hostname-1",
    providerStatus: "active",
    providerSslStatus: "active",
    ownershipVerification: null,
    ownershipVerificationHttp: null,
    sslValidationRecords: [],
    dnsRecord: {
      type: "CNAME",
      name: "docs.example.com",
      target: "cname.doxa.page",
      proxyStatus: "dns_only",
    },
    verificationError: null,
    routingStatus: "failed",
    routingHttpStatus: 522,
    routingError: "Cloudflare reached the custom hostname, but the documentation origin returned HTTP 522.",
    routingCheckedAt: "2026-08-31T10:00:00.000Z",
    createdAt: "2026-08-30T17:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
    ...overrides,
  }
}
