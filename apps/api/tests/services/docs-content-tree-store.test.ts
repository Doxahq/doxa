import { describe, expect, test } from "vitest";
import {
  buildArtifactPrefix,
  createRuntimeSearchArtifact,
  parseDocsManifestText,
  sha256Hex,
  siteBlobKey,
  versionTreeKey,
  writeVersionTree,
} from "@doxahq/docs-engine";
import { resolveSiteConfig } from "@doxahq/site-config";
import { branchIdSchema, siteIdSchema } from "@doxahq/contracts/docs-branches";
import type { StoredBranchChange } from "../../src/repositories/docs-branches";
import { encodeBranchAssetPointer } from "../../src/services/docs-branches/assets/asset-pointer";
import { createMaterializer } from "../../src/services/docs-branches/materialize";
import {
  contentTypeForKey,
  createR2DocsContentStore,
} from "../../src/services/docs-content/store";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const siteId = "11111111-1111-4111-8111-111111111111";
const otherSiteId = "99999999-9999-4999-8999-999999999999";
const baseId = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";
const basePrefix = buildArtifactPrefix(siteId, baseId);
const targetPrefix = buildArtifactPrefix(siteId, targetId);
const PAGE_COUNT = 20;

const pages = Array.from({ length: PAGE_COUNT }, (_, index) => ({
  href: index === 0 ? "/" : `/page-${index}`,
  title: `Page ${index}`,
  sourcePath: index === 0 ? "source/index.mdx" : `source/page-${index}/index.mdx`,
}));

function baseFiles(): Map<string, string> {
  const files = new Map<string, string>([
    [
      "manifest.json",
      JSON.stringify({
        siteId,
        versionId: baseId,
        projectSlug: "example",
        generatedAt: "2026-09-24T00:00:00.000Z",
        pages,
      }),
    ],
    [
      "settings/sections.json",
      JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
    ],
    [
      "settings/documents.json",
      JSON.stringify(pages.map(({ href, title }) => ({ href, title }))),
    ],
    ["extras/readme.txt", "Keep this artifact"],
  ]);

  for (const page of pages) {
    files.set(
      page.sourcePath,
      `---\ntitle: ${page.title}\n---\n\n# ${page.title}\n`,
    );
  }

  return files;
}

async function storeBaseAsTree(
  bucket: R2Bucket,
  files: Map<string, string> = baseFiles(),
) {
  return writeVersionTree(bucket, {
    siteId,
    versionId: baseId,
    files: [...files].map(([path, content]) => ({
      path,
      content,
      contentType: contentTypeForKey(path),
    })),
  });
}

/** A base version with a search index, as publications write it. */
function baseFilesWithSearch(options: { skipHref?: string } = {}) {
  const files = baseFiles();
  files.set(
    "search/index.json",
    JSON.stringify(
      createRuntimeSearchArtifact({
        contentVersion: baseId,
        pages: pages
          .filter(({ href }) => href !== options.skipHref)
          .map((page) => ({
            title: page.title,
            route: page.href,
            content: files.get(page.sourcePath) ?? "",
          })),
      }),
    ),
  );
  return files;
}

async function searchDocuments(bucket: R2Bucket, prefix: string) {
  const text = await createR2DocsContentStore(bucket).read(
    `${prefix}/search/index.json`,
  );
  const documents: { slug: string; content: string; title: string }[] =
    JSON.parse(text ?? "{}").documents;
  return new Map(documents.map((document) => [document.slug, document]));
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

function publish(bucket: R2Bucket, changedContent: string) {
  return createMaterializer({ store: createR2DocsContentStore(bucket) })({
    siteId: siteIdSchema.parse(siteId),
    base: { versionId: baseId, artifactPrefix: basePrefix },
    changes: [change("source/page-3/index.mdx", changedContent)],
    targetVersionId: targetId,
    generatedAt: "2026-09-24T01:00:00.000Z",
    siteConfig: resolveSiteConfig({ name: "Example" }),
  });
}

const changedPage = "---\ntitle: Page 3 edited\n---\n\n# Edited\n";

describe("content-addressed publication", () => {
  test("a publish uploads only new content and writes the tree last", async () => {
    const storage = createMemoryR2Bucket();
    await storeBaseAsTree(storage.bucket);
    storage.resetCalls();

    const result = await publish(storage.bucket, changedPage);

    expect(result.artifactPrefix).toBe(targetPrefix);
    expect(storage.calls.put.at(-1)).toBe(versionTreeKey(targetPrefix));
    // No listing: the base folder is listed from its tree.
    expect(storage.calls.list).toEqual([]);

    const blobPuts = storage.calls.put.filter((key) => key.includes("/blobs/"));
    for (const page of pages.filter(
      ({ sourcePath }) => sourcePath !== "source/page-3/index.mdx",
    )) {
      const unchanged = siteBlobKey(
        siteId,
        await sha256Hex(
          new TextEncoder().encode(baseFiles().get(page.sourcePath) ?? ""),
        ),
      );
      expect(blobPuts).not.toContain(unchanged);
    }
    // The edited page, the manifest, the settings and navigation that the
    // publish rebuilds, and the two search files. Unchanged pages add nothing.
    expect(blobPuts.length).toBeLessThanOrEqual(7);
    expect(blobPuts).toContain(
      siteBlobKey(siteId, await sha256Hex(new TextEncoder().encode(changedPage))),
    );
  });

  test("the published version reads back through the logical store", async () => {
    const storage = createMemoryR2Bucket();
    await storeBaseAsTree(storage.bucket);
    await publish(storage.bucket, changedPage);
    const store = createR2DocsContentStore(storage.bucket);

    expect(await store.read(`${targetPrefix}/source/page-3/index.mdx`)).toBe(
      changedPage,
    );
    expect(await store.read(`${targetPrefix}/source/page-7/index.mdx`)).toBe(
      baseFiles().get("source/page-7/index.mdx"),
    );
    expect(await store.read(`${targetPrefix}/extras/readme.txt`)).toBe(
      "Keep this artifact",
    );
    const manifest = parseDocsManifestText(
      (await store.read(`${targetPrefix}/manifest.json`)) ?? "",
    );
    expect(manifest.ok && manifest.manifest.versionId).toBe(targetId);
    expect(manifest.ok && manifest.manifest.pages[3]?.title).toBe(
      "Page 3 edited",
    );
    expect(await store.listKeys(`${targetPrefix}/source/`)).toHaveLength(
      PAGE_COUNT,
    );
    // The base version is unchanged.
    expect(await store.read(`${basePrefix}/source/page-3/index.mdx`)).toBe(
      baseFiles().get("source/page-3/index.mdx"),
    );
  });

  test("a publish from a base folder without a tree fails and writes nothing", async () => {
    const storage = createMemoryR2Bucket();
    for (const [path, content] of baseFiles()) {
      await storage.bucket.put(`${basePrefix}/${path}`, content);
    }
    storage.resetCalls();

    await expect(publish(storage.bucket, changedPage)).rejects.toThrow();
    expect(storage.calls.put).toEqual([]);
  });

  test("a publish reads no unchanged page and keeps every unchanged search entry", async () => {
    const storage = createMemoryR2Bucket();
    const files = baseFilesWithSearch();
    // An unchanged page keeps its manifest title, even when its front matter
    // has another title.
    const manifest = JSON.parse(files.get("manifest.json") ?? "{}");
    manifest.pages[7].title = "Manifest title of page 7";
    files.set("manifest.json", JSON.stringify(manifest));
    await storeBaseAsTree(storage.bucket, files);
    const pageBlobs = new Set(
      await Promise.all(
        pages.map(async ({ sourcePath }) =>
          siteBlobKey(
            siteId,
            await sha256Hex(new TextEncoder().encode(files.get(sourcePath) ?? "")),
          ),
        ),
      ),
    );
    storage.resetCalls();

    await publish(storage.bucket, changedPage);

    expect(storage.calls.get.filter((key) => pageBlobs.has(key))).toEqual([]);
    const before = await searchDocuments(storage.bucket, basePrefix);
    const after = await searchDocuments(storage.bucket, targetPrefix);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [slug, document] of after) {
      if (slug === "/page-3") continue;
      expect(document).toEqual(before.get(slug));
    }
    expect(after.get("/page-3")?.content).toContain("Edited");
    expect(after.get("/page-3")?.title).toBe("Page 3 edited");
    const published = parseDocsManifestText(
      (await createR2DocsContentStore(storage.bucket).read(
        `${targetPrefix}/manifest.json`,
      )) ?? "",
    );
    expect(published.ok && published.manifest.pages[7]?.title).toBe(
      "Manifest title of page 7",
    );
    expect(published.ok && published.manifest.pages[3]?.title).toBe(
      "Page 3 edited",
    );
  });

  test("a page without a search entry is read to create one", async () => {
    const storage = createMemoryR2Bucket();
    const files = baseFilesWithSearch({ skipHref: "/page-5" });
    await storeBaseAsTree(storage.bucket, files);
    const page5Blob = siteBlobKey(
      siteId,
      await sha256Hex(
        new TextEncoder().encode(files.get("source/page-5/index.mdx") ?? ""),
      ),
    );
    storage.resetCalls();

    await publish(storage.bucket, changedPage);

    expect(storage.calls.get).toContain(page5Blob);
    const after = await searchDocuments(storage.bucket, targetPrefix);
    expect(after.get("/page-5")?.content).toContain("Page 5");
    expect(after.size).toBe(PAGE_COUNT);
  });

  test("a version cannot reuse the folder of another site", async () => {
    const storage = createMemoryR2Bucket();
    await storeBaseAsTree(storage.bucket);

    await expect(
      createR2DocsContentStore(storage.bucket).openVersion({
        siteId: otherSiteId,
        versionId: targetId,
        basePrefix,
      }),
    ).rejects.toThrow(/own site/);
  });
});

describe("branch images in version trees", () => {
  const folderId = "55555555-5555-4555-8555-555555555555";
  const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

  async function uploadImage(bucket: R2Bucket) {
    const folder = await createR2DocsContentStore(bucket).openVersion({
      siteId,
      versionId: folderId,
    });
    await folder.put("assets/flow.png", image, "image/png");
    await folder.commit();
    return change(
      "assets/flow.png",
      encodeBranchAssetPointer({
        folderVersionId: folderId,
        sha256: await sha256Hex(image),
        size: image.byteLength,
        contentType: "image/png",
      }),
    );
  }

  test("a publish copies the image entry of its upload folder without a blob write", async () => {
    const storage = createMemoryR2Bucket();
    await storeBaseAsTree(storage.bucket);
    const imageChange = await uploadImage(storage.bucket);
    storage.resetCalls();

    const result = await createMaterializer({
      store: createR2DocsContentStore(storage.bucket),
    })({
      siteId: siteIdSchema.parse(siteId),
      base: { versionId: baseId, artifactPrefix: basePrefix },
      changes: [imageChange],
      targetVersionId: targetId,
      generatedAt: "2026-09-24T01:00:00.000Z",
      siteConfig: resolveSiteConfig({ name: "Example" }),
    });
    const store = createR2DocsContentStore(storage.bucket);

    expect(
      await store.readBytes(`${result.artifactPrefix}/assets/flow.png`),
    ).toEqual(image);
    expect(storage.calls.put).not.toContain(
      siteBlobKey(siteId, await sha256Hex(image)),
    );
  });

  test("the version size sums the files of the tree", async () => {
    const storage = createMemoryR2Bucket();
    await storeBaseAsTree(storage.bucket);
    await uploadImage(storage.bucket);
    const store = createR2DocsContentStore(storage.bucket);
    const expected = [...baseFiles().values()].reduce(
      (sum, content) => sum + new TextEncoder().encode(content).byteLength,
      0,
    );

    expect(await store.versionSize(basePrefix)).toBe(expected);
    expect(
      await store.versionSize(buildArtifactPrefix(siteId, folderId)),
    ).toBe(image.byteLength);
    expect(await store.versionSize(targetPrefix)).toBeNull();
  });

  test("a version never copies an image of another site", async () => {
    const storage = createMemoryR2Bucket();
    await uploadImage(storage.bucket);
    const writer = await createR2DocsContentStore(storage.bucket).openVersion({
      siteId: otherSiteId,
      versionId: targetId,
    });

    await expect(
      writer.copyFrom(buildArtifactPrefix(siteId, folderId), "assets/flow.png"),
    ).rejects.toThrow();
  });
});
