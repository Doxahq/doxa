import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";
import { compileSearchArtifact } from "@doxahq/docs-search";
import { runtimeSearchArtifactSchema } from "@doxahq/docs-search/contracts";
import { describe, expect, test, vi } from "vitest";

import { createSearchResponse } from "./api.search";

describe("search API", () => {
  test("returns current-site results", async () => {
    const artifact = runtimeSearchArtifactSchema.parse({
      schemaVersion: 1,
      contentVersion: "version-1",
      documents: [
        {
          id: "/install",
          slug: "/install",
          title: "Install",
          description: "",
          breadcrumb: [],
          section: "default",
          headings: [],
          keywords: [],
          content: "Install the SDK.",
          lines: [{ text: "Install the SDK." }],
        },
      ],
    });
    const source = {
      getCompiledSearchIndex: vi.fn(async () =>
        JSON.stringify(compileSearchArtifact(artifact))
      ),
      getSearchIndex: vi.fn(async () => null),
    } as unknown as DoxaDocsRuntimeSource;

    const response = await createSearchResponse(
      new Request("https://docs.example.com/api/search?q=install&limit=8"),
      source
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ slug: "/install", title: "Install" }],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("rejects invalid queries without reading the index", async () => {
    const source = {
      getCompiledSearchIndex: vi.fn(),
      getSearchIndex: vi.fn(),
    } as unknown as DoxaDocsRuntimeSource;

    const response = await createSearchResponse(
      new Request("https://docs.example.com/api/search?q=a"),
      source
    );

    expect(response.status).toBe(400);
    expect(source.getCompiledSearchIndex).not.toHaveBeenCalled();
  });
});
