import { describe, expect, test } from "vitest";

import { isGenerationPreviewHostname } from "./generation-preview-host";

describe("isGenerationPreviewHostname", () => {
  const baseDomain = "doxa.page";

  test("accepts the permanent generation hostname shape", () => {
    expect(
      isGenerationPreviewHostname("acme--a1b2c3d4e5f6.doxa.page", baseDomain)
    ).toBe(true);
  });

  // Local development serves previews on *.localhost, and the gate must engage
  // there too. It silently did not, because wrangler.json shipped the
  // production base domain to the dev server.
  test("gates a local development preview host", () => {
    expect(
      isGenerationPreviewHostname(
        "flagforge--f02c1f75ee98.localhost",
        "localhost"
      )
    ).toBe(true);
  });

  test("ignores the plain project host in local development", () => {
    expect(
      isGenerationPreviewHostname("flagforge.localhost", "localhost")
    ).toBe(false);
  });

  // The API strips a scheme, a path, and a port before it parses. This function
  // must accept anything the API resolves, or the gate lets a private preview
  // through. These cases pin that agreement.
  test.each([
    "acme--a1b2c3d4e5f6.doxa.page:8787",
    "https://acme--a1b2c3d4e5f6.doxa.page/guide",
    "acme--a1b2c3d4e5f6.doxa.page/guide",
    "acme--a1b2c3d4e5f6.doxa.page.",
  ])("gates a hostname the API still resolves: %s", (hostname) => {
    expect(isGenerationPreviewHostname(hostname, baseDomain)).toBe(true);
  });

  test.each([
    "acme--a1b2c3d4e5f6.preview.doxa.so",
    "acme.doxa.page",
    "acme--nested--a1b2c3d4e5f6.doxa.page",
    "acme--a1b2c3d4e5f.doxa.page",
    "acme--A1b2c3d4e5f6.doxa.page",
  ])("rejects the same invalid shapes as the API parser: %s", (hostname) => {
    expect(isGenerationPreviewHostname(hostname, baseDomain)).toBe(false);
  });
});
