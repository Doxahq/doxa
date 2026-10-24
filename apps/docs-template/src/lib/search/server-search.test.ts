import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";
import {
  compileSearchArtifact,
  runtimeSearchArtifactSchema,
} from "@doxahq/docs-search";
import { describe, expect, test, vi } from "vitest";

import { createServerSearch } from "./server-search";

const sourceArtifact = runtimeSearchArtifactSchema.parse({
  schemaVersion: 1,
  contentVersion: "version-1",
  documents: [
    {
      id: "/quickstart",
      slug: "/quickstart",
      title: "Quickstart",
      description: "Install Doxa",
      breadcrumb: [],
      section: "default",
      headings: ["Install"],
      keywords: ["doxa"],
      content: "Install Doxa from the command line.",
      lines: [
        { text: "Install Doxa from the command line.", anchor: "install" },
      ],
    },
  ],
});

describe("server documentation search", () => {
  test("prefers the prebuilt index and reuses it by content version", async () => {
    const source = createRuntimeSource({
      compiled: JSON.stringify(compileSearchArtifact(sourceArtifact)),
      raw: JSON.stringify(sourceArtifact),
    });
    const search = createServerSearch();

    await expect(search(source, "doxa", 8)).resolves.toMatchObject([
      { slug: "/quickstart", snippetAnchor: "install" },
    ]);
    await search(source, "install", 8);

    expect(source.getCompiledSearchIndex).toHaveBeenCalledTimes(2);
    expect(source.getSearchIndex).not.toHaveBeenCalled();
  });

  test("builds the source artifact when an older version has no prebuilt index", async () => {
    const source = createRuntimeSource({
      compiled: null,
      raw: JSON.stringify(sourceArtifact),
    });
    const search = createServerSearch();

    await expect(search(source, "command", 8)).resolves.toMatchObject([
      { slug: "/quickstart" },
    ]);
    expect(source.getSearchIndex).toHaveBeenCalledTimes(1);
  });

  test("searches legacy docs versions without a prebuilt index", async () => {
    const source = createRuntimeSource({
      compiled: null,
      raw: JSON.stringify({
        documents: [
          {
            title: "Legacy setup",
            href: "/legacy",
            text: "Install the legacy project.",
          },
        ],
      }),
    });

    await expect(
      createServerSearch()(source, "legacy", 8)
    ).resolves.toMatchObject([{ slug: "/legacy", title: "Legacy setup" }]);
  });
});

function createRuntimeSource(input: {
  compiled: string | null;
  raw: string | null;
}): DoxaDocsRuntimeSource {
  return {
    getCompiledSearchIndex: vi.fn(async () => input.compiled),
    getSearchIndex: vi.fn(async () => input.raw),
  } as unknown as DoxaDocsRuntimeSource;
}
