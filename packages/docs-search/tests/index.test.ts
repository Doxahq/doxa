import { describe, expect, test } from "vitest";

import {
  compileSearchArtifact,
  createSearchEngine,
  parseRuntimeSearchArtifact,
  runtimeSearchArtifactSchema,
  runtimeSearchQuerySchema,
} from "../src/index";

const sourceArtifact = runtimeSearchArtifactSchema.parse({
  schemaVersion: 1,
  contentVersion: "version-42",
  documents: [
    {
      id: "/quickstart",
      slug: "/quickstart",
      title: "Quickstart",
      description: "Install AI Memory",
      breadcrumb: ["Start Here"],
      section: "default",
      headings: ["Install"],
      keywords: ["cursor", "memory"],
      content: "Install AI Memory in Cursor and initialize a memory bank.",
      lines: [
        {
          text: "Install AI Memory in Cursor and initialize a memory bank.",
          anchor: "install",
        },
      ],
    },
  ],
});

describe("compiled documentation search", () => {
  test("hydrates a prebuilt index without rebuilding source documents", () => {
    const compiled = compileSearchArtifact(sourceArtifact);
    const engine = createSearchEngine(compiled);

    expect(engine.search("memory", 8)).toMatchObject([
      {
        slug: "/quickstart",
        title: "Quickstart",
        snippetAnchor: "install",
      },
    ]);
  });

  test("builds older source artifacts as a compatibility fallback", () => {
    const engine = createSearchEngine(sourceArtifact);

    expect(engine.search("cursor", 8)).toMatchObject([
      { slug: "/quickstart", title: "Quickstart" },
    ]);
  });

  test("normalizes the legacy search artifact used by old docs versions", () => {
    const legacy = parseRuntimeSearchArtifact(
      JSON.stringify({
        documents: [
          {
            title: "Legacy setup",
            href: "/legacy",
            text: "Install the legacy project.",
          },
        ],
      }),
    );

    expect(legacy?.contentVersion).toMatch(/^legacy-/);
    expect(legacy?.documents[0]).toMatchObject({
      id: "/legacy",
      slug: "/legacy",
      section: "default",
      lines: [{ text: "Install the legacy project." }],
    });
  });

  test("rejects empty, oversized, and excessive search inputs", () => {
    expect(
      runtimeSearchQuerySchema.safeParse({ query: "", limit: 8 }).success,
    ).toBe(false);
    expect(
      runtimeSearchQuerySchema.safeParse({ query: "a".repeat(201), limit: 8 })
        .success,
    ).toBe(false);
    expect(
      runtimeSearchQuerySchema.safeParse({ query: "memory", limit: 51 })
        .success,
    ).toBe(false);
  });
});
