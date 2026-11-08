import { describe, expect, test } from "vitest";

import {
  CreateCustomDocsDomainError,
  validateCustomDocsHostname,
} from "../../src/repositories/docs-domains";

describe("validateCustomDocsHostname", () => {
  test.each([
    "doxa.page",
    "victim.doxa.page",
    "docs.doxa.so",
    "victim.docs.doxa.so",
  ])("rejects the managed or retired hostname %s", (hostname) => {
    expect(() =>
      validateCustomDocsHostname({
        hostname,
        docsBaseDomain: "doxa.page",
      }),
    ).toThrowError(new CreateCustomDocsDomainError("reserved_hostname"));
  });

  describe("the official docs host", () => {
    const officialDocsProjectId = "11111111-1111-4111-8111-111111111111";

    test("lets the configured project connect docs.doxa.so", () => {
      expect(
        validateCustomDocsHostname({
          hostname: "Docs.Doxa.so.",
          docsBaseDomain: "doxa.page",
          projectId: officialDocsProjectId,
          officialDocsProjectId,
        }),
      ).toBe("docs.doxa.so");
    });

    test.each([
      { name: "another project", hostname: "docs.doxa.so", projectId: "22222222-2222-4222-8222-222222222222", official: officialDocsProjectId },
      { name: "no configured project", hostname: "docs.doxa.so", projectId: officialDocsProjectId, official: undefined },
      { name: "an empty setting", hostname: "docs.doxa.so", projectId: officialDocsProjectId, official: " " },
      { name: "a name under the host", hostname: "old-site.docs.doxa.so", projectId: officialDocsProjectId, official: officialDocsProjectId },
      { name: "the docs base domain", hostname: "doxa.page", projectId: officialDocsProjectId, official: officialDocsProjectId },
    ])("still refuses it for $name", ({ hostname, projectId, official }) => {
      expect(() =>
        validateCustomDocsHostname({
          hostname,
          docsBaseDomain: "doxa.page",
          projectId,
          officialDocsProjectId: official,
        }),
      ).toThrowError(new CreateCustomDocsDomainError("reserved_hostname"));
    });
  });

  test("accepts a customer hostname outside managed domains", () => {
    expect(
      validateCustomDocsHostname({
        hostname: "Docs.Example.com.",
        docsBaseDomain: "doxa.page",
      }),
    ).toBe("docs.example.com");
  });
});
