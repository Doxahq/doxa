import type { DocsDomainResolution } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

import { createCanonicalHostRedirect } from "../src/canonical-host-redirect";

const generated: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public",
  hostname: "demo.doxa.page",
  domainKind: "doxa_subdomain",
  renderTarget: "production",
  canonicalHostname: "docs.example.com",
};

const never = () => 1;

describe("createCanonicalHostRedirect", () => {
  test.each(["GET", "HEAD"])("sends a %s permanently to the custom domain, with path and query", (method) => {
    const response = createCanonicalHostRedirect(
      new Request("https://demo.doxa.page/guides/start?tab=npm#install", { method }),
      generated,
      { random: never },
    );

    expect(response?.status).toBe(301);
    expect(response?.headers.get("location")).toBe(
      "https://docs.example.com/guides/start?tab=npm",
    );
    expect(response?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("keeps the method and body of a write with a 308", () => {
    const response = createCanonicalHostRedirect(
      new Request("https://demo.doxa.page/api/search", { method: "POST" }),
      generated,
      { random: never },
    );
    expect(response?.status).toBe(308);
  });

  test.each<[string, DocsDomainResolution | null]>([
    ["no resolution", null],
    ["a site without a custom domain", { ...generated, canonicalHostname: undefined }],
    ["the custom domain itself", { ...generated, hostname: "docs.example.com", domainKind: "custom_domain" }],
    ["a preview", { ...generated, renderTarget: "preview" }],
    ["a generation snapshot", { ...generated, renderTarget: "generation_snapshot" }],
  ])("serves %s without a redirect", (_name, resolution) => {
    expect(
      createCanonicalHostRedirect(new Request("https://demo.doxa.page/guide"), resolution),
    ).toBeNull();
  });

  test.each([
    "/.well-known/acme-challenge/token",
    "/.well-known/cf-custom-hostname-challenge/token",
  ])("never redirects the certificate path %s", (path) => {
    expect(
      createCanonicalHostRedirect(new Request(`https://demo.doxa.page${path}`), generated),
    ).toBeNull();
  });

  test.each(["evil.com/path", "evil.com:8443", "user@evil.com", "evil.com?x", ""])(
    "refuses the target %j, which is not a bare hostname",
    (canonicalHostname) => {
      expect(
        createCanonicalHostRedirect(new Request("https://demo.doxa.page/guide"), {
          ...generated,
          canonicalHostname,
        }),
      ).toBeNull();
    },
  );
});
