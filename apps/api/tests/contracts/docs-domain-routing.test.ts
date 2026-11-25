import { describe, expect, test } from "vitest";
import {
  docsDomainResolutionSchema,
  docsDomainSchema,
} from "@doxahq/contracts";

describe("docs domain routing contract", () => {
  test("keeps certificate readiness separate from routing health", () => {
    const domain = {
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
      routingError: "The documentation origin returned HTTP 522.",
      routingCheckedAt: "2026-08-31T10:00:00.000Z",
      createdAt: "2026-08-30T17:00:00.000Z",
      updatedAt: "2026-08-31T10:00:00.000Z",
    };

    expect(docsDomainSchema.parse(domain)).toEqual(domain);
  });
});

test("identifies the renderer target without changing the public URL contract", () => {
  const resolution = docsDomainResolutionSchema.parse({
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "example",
    publishedVersionId: "version-1",
    artifactPrefix: "sites/site-1/versions/version-1",
    manifestPath: "sites/site-1/versions/version-1/manifest.json",
    accessPolicy: "public",
    hostname: "example.doxa.page",
    domainKind: "doxa_subdomain",
    renderTarget: "production",
  });

  expect(resolution.renderTarget).toBe("production");
});

describe("preview kind of a docs host resolution", () => {
  const preview = {
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "example",
    publishedVersionId: "version-1",
    artifactPrefix: "sites/site-1/versions/version-1",
    manifestPath: "sites/site-1/versions/version-1/manifest.json",
    accessPolicy: "public",
    hostname: "example-pr-1.doxa.page",
    domainKind: "doxa_subdomain",
    renderTarget: "preview",
  } as const;

  test.each(["source_change", "branch"] as const)("keeps %s", (previewKind) => {
    expect(docsDomainResolutionSchema.parse({ ...preview, previewKind }).previewKind).toBe(previewKind);
  });

  test("reads a resolution from an older resolver without the kind", () => {
    expect(docsDomainResolutionSchema.parse(preview).previewKind).toBeUndefined();
  });

  test("reads an unknown kind as absent, so the resolution still parses", () => {
    const parsed = docsDomainResolutionSchema.parse({ ...preview, previewKind: "future_kind" });
    expect(parsed.previewKind).toBeUndefined();
    expect(parsed.renderTarget).toBe("preview");
  });
});
