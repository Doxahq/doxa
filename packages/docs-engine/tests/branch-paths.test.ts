import { describe, expect, it } from "vitest";
import { documentSectionSlug, navigationPathForSection } from "../src/index";

describe("branch navigation paths", () => {
  const prefix = "sites/site/versions/version";

  it("maps the default and named sections to the existing artifact paths", () => {
    expect(navigationPathForSection(prefix, "default")).toBe(
      `${prefix}/settings/documents.json`,
    );
    expect(navigationPathForSection(prefix, "api-reference")).toBe(
      `${prefix}/settings/documents.api-reference.json`,
    );
  });

  it("reads section slugs only from the selected prefix", () => {
    expect(
      documentSectionSlug(`${prefix}/settings/documents.json`, prefix),
    ).toBe("default");
    expect(
      documentSectionSlug(`${prefix}/settings/documents.api.json`, prefix),
    ).toBe("api");
    expect(
      documentSectionSlug(
        "sites/other/versions/version/settings/documents.api.json",
        prefix,
      ),
    ).toBeNull();
    expect(
      documentSectionSlug(`${prefix}/settings/site.json`, prefix),
    ).toBeNull();
  });

  it("rejects an unsafe section slug before building a key", () => {
    expect(() => navigationPathForSection(prefix, "../other")).toThrow(
      "Invalid section slug",
    );
  });
});
