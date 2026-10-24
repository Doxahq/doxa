import { describe, expect, test } from "vitest";
import {
  createDocsUrl,
  createGenerationPreviewHostname,
  createGenerationPreviewUrl,
  createGeneratedDocsHostname,
  parseGenerationPreviewSubdomain,
  parseGeneratedDocsSubdomain,
} from "../../src/utils/docs-url";

describe("createDocsUrl", () => {
  test("uses generated Doxa preview subdomains when DOCS_BASE_DOMAIN is configured", () => {
    expect(
      createDocsUrl("demo", {
        DOCS_BASE_DOMAIN: "Doxa.Page.",
        DOCS_RUNTIME_URL: "https://preview.doxa.so",
      }),
    ).toBe("https://demo.doxa.page");
  });

  test("uses the local renderer origin for generated localhost subdomains", () => {
    expect(
      createDocsUrl("demo", {
        DOCS_BASE_DOMAIN: "localhost",
        DOCS_RENDERER_BASE_URL: "http://localhost:3002",
        DOCS_RUNTIME_URL: "http://localhost:8788",
      }),
    ).toBe("http://demo.localhost:3002");
  });

  test("ignores malformed renderer origins instead of generating unsafe URLs", () => {
    expect(
      createDocsUrl("demo", {
        DOCS_BASE_DOMAIN: "doxa.page",
        DOCS_RENDERER_BASE_URL: "javascript:alert(1)",
      }),
    ).toBe("https://demo.doxa.page");
  });

  test("falls back to legacy docs runtime URLs when no base domain is configured", () => {
    expect(
      createDocsUrl("demo", {
        DOCS_RUNTIME_URL: "https://preview.doxa.so/",
      }),
    ).toBe("https://preview.doxa.so/demo");
  });

  test("returns null when no generated base or runtime URL is configured", () => {
    expect(createDocsUrl("demo", {})).toBeNull();
  });
});

describe("generation preview hostnames", () => {
  const baseDomain = "doxa.page";
  const validHostname = "acme--a1b2c3d4e5f6.doxa.page";

  test("parses a permanent generation preview hostname", () => {
    expect(parseGenerationPreviewSubdomain(validHostname, baseDomain)).toEqual({
      hostname: validHostname,
      projectSlug: "acme",
      versionIdPrefix: "a1b2c3d4e5f6",
    });
  });

  // isGenerationPreviewHostname in
  // apps/docs-template/src/lib/generation-preview-host.ts must return true for
  // every hostname this parser resolves, or the renderer skips its access gate.
  // These cases pin that agreement. Keep both lists the same.
  test.each([
    "acme--a1b2c3d4e5f6.doxa.page:8787",
    "https://acme--a1b2c3d4e5f6.doxa.page/guide",
    "acme--a1b2c3d4e5f6.doxa.page/guide",
    "acme--a1b2c3d4e5f6.doxa.page.",
  ])("resolves a hostname the renderer also gates: %s", (hostname) => {
    expect(
      parseGenerationPreviewSubdomain(hostname, baseDomain)?.hostname,
    ).toBe(validHostname);
  });

  test.each([
    "acme--a1b2c3d4e5f6.preview.doxa.so",
    "acme.doxa.page",
    "acme--nested--a1b2c3d4e5f6.doxa.page",
    "acme--a1b2c3d4e5f.doxa.page",
    "acme--A1b2c3d4e5f6.doxa.page",
    "acme.doxa.page",
  ])("rejects an invalid permanent hostname: %s", (hostname) => {
    expect(parseGenerationPreviewSubdomain(hostname, baseDomain)).toBeNull();
  });

  test("creates and parses a hostname from a UUID", () => {
    const hostname = createGenerationPreviewHostname(
      {
        projectSlug: "acme-docs",
        docsVersionId: "a1b2c3d4-e5f6-4789-8123-456789abcdef",
      },
      baseDomain,
    );

    expect(hostname).toBe("acme-docs--a1b2c3d4e5f6.doxa.page");
    expect(
      parseGenerationPreviewSubdomain(hostname ?? "", baseDomain),
    ).toMatchObject({
      projectSlug: "acme-docs",
      versionIdPrefix: "a1b2c3d4e5f6",
    });
  });
});

describe("createGeneratedDocsHostname", () => {
  test("normalizes generated preview hostnames", () => {
    expect(createGeneratedDocsHostname("Demo", "Doxa.Page.")).toBe(
      "demo.doxa.page",
    );
  });

  test("rejects invalid generated preview hostnames", () => {
    expect(createGeneratedDocsHostname("bad_slug", "doxa.page")).toBeNull();
    expect(createGeneratedDocsHostname("one.two", "doxa.page")).toBeNull();
  });
});

describe("parseGeneratedDocsSubdomain", () => {
  test("extracts the project slug from a generated preview hostname", () => {
    expect(parseGeneratedDocsSubdomain("Demo.Doxa.Page", "doxa.page")).toEqual({
      hostname: "demo.doxa.page",
      projectSlug: "demo",
    });
  });

  test("does not parse the base domain itself as a project hostname", () => {
    expect(parseGeneratedDocsSubdomain("doxa.page", "doxa.page")).toBeNull();
  });

  test("does not parse nested hostnames or the wrong base domain", () => {
    expect(
      parseGeneratedDocsSubdomain("one.two.doxa.page", "doxa.page"),
    ).toBeNull();
    expect(
      parseGeneratedDocsSubdomain("demo.preview.doxa.so", "doxa.page"),
    ).toBeNull();
  });
});

describe("createGenerationPreviewUrl", () => {
  const version = {
    projectSlug: "acme-docs",
    docsVersionId: "a1b2c3d4-e5f6-4789-8123-456789abcdef",
  };

  test("serves the version on its own host", () => {
    expect(createGenerationPreviewUrl(version, { DOCS_BASE_DOMAIN: "doxa.page" }))
      .toBe("https://acme-docs--a1b2c3d4e5f6.doxa.page");
  });

  test("uses the local renderer origin and port", () => {
    expect(createGenerationPreviewUrl(version, {
      DOCS_BASE_DOMAIN: "localhost",
      DOCS_RENDERER_BASE_URL: "http://localhost:3002",
    })).toBe("http://acme-docs--a1b2c3d4e5f6.localhost:3002");
  });

  test("returns null without a docs base domain", () => {
    expect(createGenerationPreviewUrl(version, {})).toBeNull();
  });
});
