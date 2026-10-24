import { describe, expect, test } from "vitest";
import {
  DOCS_PAGE_SLUG_PATTERN,
  DOCS_SECTION_SLUG_PATTERN,
  docsContentEditSchema,
} from "@doxahq/contracts";

describe("docs content structure edit contract", () => {
  test("accepts every structure operation", () => {
    const edits = [
      { type: "create_section", slug: "api", label: "API Reference" },
      { type: "rename_section", slug: "api", label: "REST API" },
      { type: "create_group", sectionSlug: "api", heading: "Endpoints" },
      { type: "rename_group", sectionSlug: "api", groupIndex: 0, heading: "Resources" },
      { type: "create_page", sectionSlug: "api", groupIndex: 0, title: "Flags", slug: "flags" },
      { type: "rename_page", href: "/api/flags", title: "Feature flags", slug: "feature-flags" },
      { type: "move_section", slug: "api", beforeSlug: "guides" },
      {
        type: "move_group",
        sectionSlug: "api",
        groupIndex: 0,
        toSectionSlug: "guides",
        beforeGroupIndex: null,
      },
      {
        type: "move_page",
        href: "/api/flags",
        toSectionSlug: "guides",
        toGroupIndex: null,
        beforeHref: null,
      },
    ];

    expect(edits.every((edit) => docsContentEditSchema.safeParse(edit).success)).toBe(true);
  });

  test("exports the renderer-compatible slug patterns", () => {
    expect(DOCS_SECTION_SLUG_PATTERN.test("api-reference")).toBe(true);
    expect(DOCS_SECTION_SLUG_PATTERN.test("API Reference")).toBe(false);
    expect(DOCS_PAGE_SLUG_PATTERN.test("guides/first-page")).toBe(true);
    expect(DOCS_PAGE_SLUG_PATTERN.test("/guides/first-page")).toBe(false);
  });

  test.each([
    { type: "create_section", slug: "API", label: "API" },
    { type: "create_page", sectionSlug: "default", groupIndex: null, title: "Page", slug: "/page" },
    { type: "rename_group", sectionSlug: "default", groupIndex: -1, heading: "Guides" },
    { type: "rename_page", href: "/guide", title: " ", slug: "guide" },
  ])("rejects an invalid structure edit: $type", (edit) => {
    expect(docsContentEditSchema.safeParse(edit).success).toBe(false);
  });
});
