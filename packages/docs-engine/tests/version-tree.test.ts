import { describe, expect, test } from "vitest";
import {
  VersionTreeCache,
  VersionTreeWriter,
  createVersionTreeReader,
  isSafeVersionTreePath,
  parseVersionArtifactKey,
  parseVersionPrefix,
  sha256Hex,
  siteBlobKey,
  versionTreeKey,
  writeVersionTree,
  type VersionTreeObject,
  type VersionTreeStorage,
} from "../src/version-tree";

const siteId = "11111111-1111-4111-8111-111111111111";
const otherSiteId = "22222222-2222-4222-8222-222222222222";
const baseId = "33333333-3333-4333-8333-333333333333";
const nextId = "44444444-4444-4444-8444-444444444444";
const basePrefix = `sites/${siteId}/versions/${baseId}`;
const nextPrefix = `sites/${siteId}/versions/${nextId}`;
const MDX = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const gets: string[] = [];
  const puts: string[] = [];
  const storage: VersionTreeStorage = {
    async get(key) {
      gets.push(key);
      const bytes = objects.get(key);
      return bytes ? objectOf(bytes) : null;
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async put(key, value) {
      puts.push(key);
      objects.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
    },
  };
  const text = (key: string) => {
    const bytes = objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  };
  return { storage, objects, gets, puts, text };
}

function objectOf(bytes: Uint8Array): VersionTreeObject {
  return {
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
    size: bytes.byteLength,
  };
}

async function writeBase(storage: VersionTreeStorage) {
  return writeVersionTree(storage, {
    siteId,
    versionId: baseId,
    files: [
      { path: "manifest.json", content: '{"pages":[]}', contentType: JSON_TYPE },
      { path: "source/index.mdx", content: "# Home\n", contentType: MDX },
      { path: "source/guide/index.mdx", content: "# Guide\n", contentType: MDX },
    ],
  });
}

describe("version tree keys and paths", () => {
  test("parses version keys and leaves other keys alone", () => {
    expect(parseVersionArtifactKey(`${basePrefix}/source/index.mdx`)).toEqual({
      siteId,
      versionId: baseId,
      prefix: basePrefix,
      path: "source/index.mdx",
    });
    expect(parseVersionArtifactKey(`sites/${siteId}/assets/abc`)).toBeNull();
    expect(parseVersionArtifactKey("_generation-checkpoints/job/x.json")).toBeNull();
    expect(parseVersionPrefix(basePrefix)?.prefix).toBe(basePrefix);
    expect(parseVersionPrefix(`${basePrefix}/`)?.prefix).toBe(basePrefix);
    expect(parseVersionPrefix(`${basePrefix}/source`)).toBeNull();
  });

  test("rejects unsafe folder segments and unsafe paths", () => {
    expect(() =>
      parseVersionArtifactKey(`sites/../versions/${baseId}/manifest.json`),
    ).toThrow(/Unsafe/);
    for (const path of [
      "",
      "/manifest.json",
      "../manifest.json",
      "source/../x",
      "source//x",
      "source\\x",
      "tree.json",
      "source/./x",
    ]) {
      expect(isSafeVersionTreePath(path), path).toBe(false);
    }
    expect(isSafeVersionTreePath("source/guide/index.mdx")).toBe(true);
  });

  test("builds blob keys only from a valid hash", () => {
    expect(siteBlobKey(siteId, "a".repeat(64))).toBe(
      `sites/${siteId}/blobs/${"a".repeat(64)}`,
    );
    expect(() => siteBlobKey(siteId, "../x")).toThrow();
  });
});

describe("version tree writer", () => {
  test("writes each unique blob once and the tree last", async () => {
    const { storage, puts, text } = memoryStorage();
    const writer = new VersionTreeWriter(storage, { siteId, versionId: baseId });

    await writer.put("source/a/index.mdx", "same", MDX);
    await writer.put("source/b/index.mdx", "same", MDX);
    await writer.put("manifest.json", "{}", JSON_TYPE);
    const commit = await writer.commit();

    expect(puts.at(-1)).toBe(versionTreeKey(basePrefix));
    expect(puts.filter((key) => key.includes("/blobs/"))).toHaveLength(2);
    expect(commit.artifactPrefix).toBe(basePrefix);
    expect(commit.manifestPath).toBe(`${basePrefix}/manifest.json`);
    expect(Object.keys(commit.tree.files)).toEqual([
      "manifest.json",
      "source/a/index.mdx",
      "source/b/index.mdx",
    ]);
    expect(commit.tree.files["source/a/index.mdx"]).toEqual({
      sha256: await sha256Hex(new TextEncoder().encode("same")),
      size: 4,
      contentType: MDX,
    });
    expect(JSON.parse(text(versionTreeKey(basePrefix)) ?? "")).toEqual(
      commit.tree,
    );
  });

  test("reuses the blobs of the base tree without a read or a write", async () => {
    const { storage, gets, puts } = memoryStorage();
    const base = await writeBase(storage);
    gets.length = 0;
    puts.length = 0;

    const writer = new VersionTreeWriter(storage, {
      siteId,
      versionId: nextId,
      base: base.tree,
    });
    writer.copy("source/guide/index.mdx");
    await writer.put("source/index.mdx", "# Home\n", MDX);
    await writer.put("manifest.json", '{"pages":[1]}', JSON_TYPE);
    const next = await writer.commit();

    expect(gets).toEqual([]);
    expect(puts).toEqual([
      siteBlobKey(siteId, next.tree.files["manifest.json"].sha256),
      versionTreeKey(nextPrefix),
    ]);
    expect(next.tree.files["source/guide/index.mdx"]).toEqual(
      base.tree.files["source/guide/index.mdx"],
    );
    expect(writer.uploadedBlobCount).toBe(1);
  });

  test("uploads a blob again when a sweep deleted it before the tree existed", async () => {
    const { storage, objects, puts } = memoryStorage();
    const writer = new VersionTreeWriter(storage, { siteId, versionId: baseId });
    const entry = await writer.put("source/index.mdx", "# Home\n", MDX);
    const blobKey = siteBlobKey(siteId, entry.sha256);

    objects.delete(blobKey);
    await writer.commit();

    expect(objects.has(blobKey)).toBe(true);
    expect(puts.filter((key) => key === blobKey)).toHaveLength(2);
  });

  test("refuses unsafe paths, a base of another site, and a second commit", async () => {
    const { storage } = memoryStorage();
    const base = await writeBase(storage);
    const writer = new VersionTreeWriter(storage, { siteId, versionId: nextId });

    await expect(writer.put("../x", "x", MDX)).rejects.toThrow(/Unsafe/);
    await expect(writer.put("tree.json", "x", MDX)).rejects.toThrow(/Unsafe/);
    expect(() => writer.copy("source/index.mdx")).toThrow(/no base tree/);
    expect(
      () =>
        new VersionTreeWriter(storage, {
          siteId: otherSiteId,
          versionId: nextId,
          base: base.tree,
        }),
    ).toThrow(/own site/);

    await writer.commit();
    await expect(writer.put("source/x/index.mdx", "x", MDX)).rejects.toThrow(
      /already committed/,
    );
  });
});

describe("version tree reader", () => {
  test("reads logical keys through the tree", async () => {
    const { storage } = memoryStorage();
    await writeBase(storage);
    const reader = createVersionTreeReader(storage);

    const home = await reader.get(`${basePrefix}/source/index.mdx`);
    expect(await home?.text()).toBe("# Home\n");
    expect(home?.httpMetadata?.contentType).toBe(MDX);
    expect(home?.size).toBe(7);
    expect(await reader.get(`${basePrefix}/source/missing/index.mdx`)).toBeNull();
    expect(await reader.get(`${basePrefix}/tree.json`)).toBeNull();
    expect(await reader.listVersionKeys(`${basePrefix}/source/`)).toEqual([
      `${basePrefix}/source/guide/index.mdx`,
      `${basePrefix}/source/index.mdx`,
    ]);
    expect(await reader.listVersionKeys(`${basePrefix}/`)).toHaveLength(3);
  });

  test("passes keys outside version folders through unchanged", async () => {
    const { storage } = memoryStorage();
    await storage.put(`sites/${siteId}/assets/${"b".repeat(64)}`, "png");
    const reader = createVersionTreeReader(storage);

    expect(
      await (await reader.get(`sites/${siteId}/assets/${"b".repeat(64)}`))?.text(),
    ).toBe("png");
  });

  test("treats a folder without a tree as missing, even when it holds flat files", async () => {
    const { storage } = memoryStorage();
    await storage.put(`${basePrefix}/manifest.json`, "flat");

    expect(
      await createVersionTreeReader(storage).get(`${basePrefix}/manifest.json`),
    ).toBeNull();
    expect(
      await createVersionTreeReader(storage).listVersionKeys(`${basePrefix}/`),
    ).toBeNull();
  });

  test("fails closed on an invalid tree, a foreign tree, or a missing blob", async () => {
    const invalid = memoryStorage();
    await invalid.storage.put(versionTreeKey(basePrefix), "{not json");
    await expect(
      createVersionTreeReader(invalid.storage).get(`${basePrefix}/manifest.json`),
    ).rejects.toThrow(/not JSON/);

    const foreign = memoryStorage();
    const written = await writeBase(foreign.storage);
    await foreign.storage.put(
      versionTreeKey(nextPrefix),
      JSON.stringify(written.tree),
    );
    await expect(
      createVersionTreeReader(foreign.storage).get(`${nextPrefix}/manifest.json`),
    ).rejects.toThrow(/another folder/);

    const missing = memoryStorage();
    const base = await writeBase(missing.storage);
    missing.objects.delete(
      siteBlobKey(siteId, base.tree.files["source/index.mdx"].sha256),
    );
    await expect(
      createVersionTreeReader(missing.storage).get(`${basePrefix}/source/index.mdx`),
    ).rejects.toThrow(/missing/);
  });

  test("keeps a parsed tree in the cache and never keeps a missing tree", async () => {
    const { storage, gets } = memoryStorage();
    const cache = new VersionTreeCache();
    const reader = createVersionTreeReader(storage, { cache });

    expect(await reader.readTree(basePrefix)).toBeNull();
    await writeBase(storage);
    gets.length = 0;

    expect(await reader.readTree(basePrefix)).not.toBeNull();
    await reader.get(`${basePrefix}/source/index.mdx`);
    await reader.get(`${basePrefix}/manifest.json`);

    expect(gets.filter((key) => key.endsWith("/tree.json"))).toEqual([
      versionTreeKey(basePrefix),
    ]);
  });
});
