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

  test("accepts a customer hostname outside managed domains", () => {
    expect(
      validateCustomDocsHostname({
        hostname: "Docs.Example.com.",
        docsBaseDomain: "doxa.page",
      }),
    ).toBe("docs.example.com");
  });
});
