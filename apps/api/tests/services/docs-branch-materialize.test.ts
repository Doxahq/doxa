import { describe, expect, test } from "vitest";
import {
  buildArtifactPrefix,
  parseDocsManifestText,
} from "@doxahq/docs-engine";
import { resolveSiteConfig } from "@doxahq/site-config";
import { branchIdSchema, siteIdSchema } from "@doxahq/contracts/docs-branches";
import type { StoredBranchChange } from "../../src/repositories/docs-branches";
import { createMaterializer } from "../../src/services/docs-branches/materialize";
import { EffectiveTree } from "../../src/services/docs-branches/effective-tree";
import { validateTree } from "../../src/services/docs-branches/validate-tree";
import type { DocsContentStore } from "../../src/services/docs-content/store";
import { createInMemoryDocsContentStore } from "../support/in-memory-docs-content-store";

const siteId = "11111111-1111-4111-8111-111111111111";
const baseId = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";
const basePrefix = buildArtifactPrefix(siteId, baseId);

function fixture() {
  const objects = new Map<string, string>([
    [
      `${basePrefix}/manifest.json`,
      JSON.stringify({
        siteId,
        versionId: baseId,
        projectSlug: "example",
        generatedAt: "2026-09-24T00:00:00.000Z",
        pages: [{ href: "/", title: "Home", sourcePath: "source/index.mdx" }],
      }),
    ],
    [`${basePrefix}/source/index.mdx`, "---\ntitle: Home\n---\n\n# Home\n"],
    [
      `${basePrefix}/settings/sections.json`,
      JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
    ],
    [
      `${basePrefix}/settings/documents.json`,
      JSON.stringify([{ href: "/", title: "Home" }]),
    ],
    [`${basePrefix}/extras/readme.txt`, "Keep this artifact"],
  ]);
  const store = createInMemoryDocsContentStore(objects);
  return { store, objects };
}

function change(path: string, content: string): StoredBranchChange {
  return {
    branchId: branchIdSchema.parse("44444444-4444-4444-8444-444444444444"),
    path,
    kind: "upsert",
    content,
    contentSha256: "0".repeat(64),
    byteSize: new TextEncoder().encode(content).byteLength,
    updatedByUserId: "owner",
    origin: "editor",
    updatedAt: new Date(),
  };
}

describe("branch tree validation and materialization", () => {
  test("a valid tree has no issue and a missing page is rejected", async () => {
    const { store, objects } = fixture();
    expect(
      await validateTree(new EffectiveTree(store, basePrefix, [])),
    ).toEqual([]);
    objects.delete(`${basePrefix}/source/index.mdx`);
    expect(
      await validateTree(new EffectiveTree(store, basePrefix, [])),
    ).toContainEqual(
      expect.objectContaining({ code: "structure_missing_page" }),
    );
  });

  test("checks that pages exist from one listing, without reading page bodies", async () => {
    const { store } = fixture();
    const reads: string[] = [];
    const listings: string[] = [];
    const counted: DocsContentStore = {
      ...store,
      read: (key) => {
        reads.push(key);
        return store.read(key);
      },
      listKeys: (prefix) => {
        listings.push(prefix);
        return store.listKeys(prefix);
      },
    };

    expect(
      await validateTree(new EffectiveTree(counted, basePrefix, [])),
    ).toEqual([]);
    expect(reads.filter((key) => key.includes("/source/"))).toEqual([]);
    expect(listings).toEqual([`${basePrefix}/source/`]);
  });

  test("a page that the branch deletes is missing, and a page that it adds exists", async () => {
    const { store, objects } = fixture();
    const deleted: StoredBranchChange = {
      ...change("source/index.mdx", ""),
      kind: "delete",
      content: null,
      contentSha256: null,
      byteSize: 0,
    };

    expect(
      await validateTree(new EffectiveTree(store, basePrefix, [deleted])),
    ).toContainEqual(
      expect.objectContaining({
        code: "structure_missing_page",
        params: { href: "/" },
      }),
    );

    objects.delete(`${basePrefix}/source/index.mdx`);
    expect(
      await validateTree(
        new EffectiveTree(store, basePrefix, [
          change("source/index.mdx", "# Home"),
        ]),
      ),
    ).toEqual([]);
  });

  test("a source file outside the manifest is an orphan warning", async () => {
    const { store } = fixture();
    const issues = await validateTree(
      new EffectiveTree(store, basePrefix, [
        change("source/extra/index.mdx", "# Extra"),
      ]),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "orphan_page",
        severity: "warning",
        params: { href: "/extra" },
      }),
    );
  });

  test("publishes schema v2, titles, search, settings, and unrelated base artifacts", async () => {
    const { store, objects } = fixture();
    const result = await createMaterializer({ store })({
      siteId: siteIdSchema.parse(siteId),
      base: { versionId: baseId, artifactPrefix: basePrefix },
      changes: [
        change("source/index.mdx", "---\ntitle: Updated\n---\n\n# Updated\n"),
      ],
      targetVersionId: targetId,
      generatedAt: "2026-09-24T01:00:00.000Z",
      siteConfig: resolveSiteConfig({ name: "Example" }),
    });
    const targetPrefix = buildArtifactPrefix(siteId, targetId);
    expect(result.artifactPrefix).toBe(targetPrefix);
    expect(result.summary).toMatchObject({
      changedPageCount: 1,
      pageTitles: ["Updated"],
    });
    expect(objects.get(`${targetPrefix}/source/index.mdx`)).toContain(
      "# Updated",
    );
    const manifest = parseDocsManifestText(
      objects.get(`${targetPrefix}/manifest.json`) ?? "",
    );
    expect(manifest.ok && manifest.manifest.schemaVersion).toBe(2);
    expect(manifest.ok && manifest.manifest.pages[0]?.title).toBe("Updated");
    expect(objects.get(`${targetPrefix}/settings/documents.json`)).toContain(
      "Updated",
    );
    expect(objects.get(`${targetPrefix}/settings/site.json`)).toContain(
      "Example",
    );
    expect(objects.get(`${targetPrefix}/search/index.json`)).toContain(
      "Updated",
    );
    expect(objects.has(`${targetPrefix}/search/minisearch.json`)).toBe(true);
    expect(objects.get(`${targetPrefix}/extras/readme.txt`)).toBe(
      "Keep this artifact",
    );
  });
});
