import { describe, expect, test, vi } from "vitest";
import type { DocsDomainDto } from "@doxahq/contracts";
import { DocsDomainDnsHostService } from "../../src/services/docs-domain-dns-host";
import { UNKNOWN_DNS_HOST } from "../../src/services/dns-host-detection";

const INPUT = { userId: "user-1", projectId: "project-1", domainId: "domain-1" };
const CLOUDFLARE_HOST = {
  provider: "cloudflare" as const,
  zone: "example.com",
  nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
};

describe("DocsDomainDnsHostService", () => {
  test("detects the DNS host of a custom domain in the project", async () => {
    const { service, domains, detector } = createService(createDomain());

    await expect(service.detectForProject(INPUT)).resolves.toEqual(CLOUDFLARE_HOST);
    expect(domains.getForProject).toHaveBeenCalledWith(INPUT);
    expect(detector.detect).toHaveBeenCalledWith("docs.example.com");
  });

  test("returns null for a domain outside the project", async () => {
    const { service, detector } = createService(null);

    await expect(service.detectForProject(INPUT)).resolves.toBeNull();
    expect(detector.detect).not.toHaveBeenCalled();
  });

  test("does not look up a Doxa subdomain", async () => {
    const { service, detector } = createService(createDomain({ kind: "doxa_subdomain", hostname: "acme.doxa.page" }));

    await expect(service.detectForProject(INPUT)).resolves.toEqual(UNKNOWN_DNS_HOST);
    expect(detector.detect).not.toHaveBeenCalled();
  });
});

function createService(domain: DocsDomainDto | null) {
  const domains = { getForProject: vi.fn(async () => domain) };
  const detector = { detect: vi.fn(async () => CLOUDFLARE_HOST) };
  const service = new DocsDomainDnsHostService({} as never, { domains, detector });
  return { service, domains, detector };
}

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
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}
