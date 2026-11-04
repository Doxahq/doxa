import { describe, expect, test } from "vitest";

import { toHostResolution } from "../src/host-resolution";

const resolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public" as const,
  hostname: "docs.example.com",
  domainKind: "custom_domain" as const,
  renderTarget: "production" as const,
};

describe("toHostResolution", () => {
  test("gives each hostname its own site URL for canonical links (RES-7)", () => {
    expect(toHostResolution(resolution).siteUrl).toBe("https://docs.example.com");
    expect(
      toHostResolution({
        ...resolution,
        hostname: "demo.doxa.page",
        domainKind: "doxa_subdomain",
      }).siteUrl,
    ).toBe("https://demo.doxa.page");
  });

  test("passes only the pinned scope and the site URL", () => {
    expect(Object.keys(toHostResolution(resolution)).sort()).toEqual([
      "accessPolicy",
      "artifactPrefix",
      "manifestPath",
      "projectId",
      "projectSlug",
      "publishedVersionId",
      "siteId",
      "siteUrl",
    ]);
  });
});
