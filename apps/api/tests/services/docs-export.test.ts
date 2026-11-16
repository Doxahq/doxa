import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, test, vi } from "vitest";
import {
  buildArtifactPrefix,
  createVersionTreeReader,
  sha256Hex,
  siteBlobKey,
  writeVersionTree,
  type VersionTree,
} from "@doxahq/docs-engine";
import type { PublishedDocsContentVersion } from "../../src/repositories/docs-content";
import {
  EXPORT_MAX_BYTES,
  exportFileName,
  exportTreeEntries,
  siteAssetHashes,
} from "../../src/services/docs-export/entries";
import { DocsExportService, type DocsExportPlan } from "../../src/services/docs-export/service";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const siteId = "11111111-1111-4111-8111-111111111111";
const otherSiteId = "99999999-9999-4999-8999-999999999999";
const versionId = "22222222-2222-4222-8222-222222222222";
const prefix = buildArtifactPrefix(siteId, versionId);
const LOGO = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const NOW = new Date("2026-11-16T12:00:00.000Z");

function tree(paths: Record<string, number>): VersionTree {
  return {
    format: "doxa-version-tree",
    formatVersion: 1,
    siteId,
    versionId,
    files: Object.fromEntries(
      Object.entries(paths).map(([path, size]) => [path, { sha256: "a".repeat(64), size, contentType: "text/plain" }]),
    ),
  } as VersionTree;
}

describe("export entries", () => {
  test("map artifact paths to the archive layout and skip derived files", () => {
    const entries = exportTreeEntries(
      tree({
        "manifest.json": 1,
        "search/index.json": 1,
        "search/minisearch.json": 1,
        "settings/site.json": 1,
        "settings/sections.json": 1,
        "settings/documents.api.json": 1,
        "source/index.mdx": 1,
        "source/guides/auth/index.mdx": 1,
        "assets/diagram.png": 1,
        "future/thing.bin": 1,
      }),
    );
    expect(Object.fromEntries(entries.map((entry) => [entry.artifactPath, entry.zipPath]))).toEqual({
      "settings/site.json": "doxa.json",
      "settings/sections.json": "settings/sections.json",
      "settings/documents.api.json": "settings/documents.api.json",
      "source/index.mdx": "pages/index.mdx",
      "source/guides/auth/index.mdx": "pages/guides/auth.mdx",
      "assets/diagram.png": "assets/diagram.png",
      "future/thing.bin": "other/future/thing.bin",
    });
  });

  test("never give two files one archive path", () => {
    const entries = exportTreeEntries(tree({ "source/a/index.mdx": 1, "source/a.mdx": 1, "source/index/index.mdx": 1, "source/index.mdx": 1 }));
    const paths = entries.map((entry) => entry.zipPath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).not.toContain("export.json");
  });

  test("find only well-formed asset refs", () => {
    const hash = "b".repeat(64);
    const text = JSON.stringify({ branding: { logo: { light: `asset:${hash}`, dark: `asset:${hash}` }, favicon: "asset:../../x", ogImage: `asset:${"c".repeat(63)}` } });
    expect(siteAssetHashes(text)).toEqual([hash]);
  });

  test("make a safe file name", () => {
    expect(exportFileName('acme"; filename=evil.exe', NOW)).toBe("acme-filename-evil-exe-docs-2026-11-16.zip");
    expect(exportFileName("", NOW)).toBe("docs-docs-2026-11-16.zip");
  });
});

async function setup(options: { published?: boolean; siteAssets?: boolean } = {}) {
  const storage = createMemoryR2Bucket();
  const logoHash = await sha256Hex(LOGO);
  await writeVersionTree(storage.bucket, {
    siteId,
    versionId,
    files: [
      { path: "manifest.json", content: "{}", contentType: "application/json" },
      { path: "search/index.json", content: "[]", contentType: "application/json" },
      {
        path: "settings/site.json",
        content: JSON.stringify({ name: "Acme", branding: { logo: { light: `asset:${logoHash}`, dark: null } } }),
        contentType: "application/json",
      },
      { path: "settings/sections.json", content: "[]", contentType: "application/json" },
      { path: "source/index.mdx", content: "# Home\n", contentType: "text/markdown" },
      { path: "source/guides/auth/index.mdx", content: "# Auth\n", contentType: "text/markdown" },
      { path: "assets/diagram.png", content: new Uint8Array([1, 2, 3]), contentType: "image/png" },
    ],
  });
  const published: PublishedDocsContentVersion = {
    projectId: "project-1",
    projectName: "Acme",
    projectSlug: "acme",
    siteId,
    versionId,
    versionNumber: 7,
    artifactPrefix: prefix,
    manifestPath: `${prefix}/manifest.json`,
    createdAt: new Date("2026-11-15T09:00:00.000Z"),
  };
  const getPublishedVersionForUser = vi.fn(async () => (options.published === false ? null : published));
  const assetReads: string[] = [];
  const siteAssets = {
    head: vi.fn(async (site: string, hash: string) =>
      options.siteAssets !== false && site === siteId && hash === logoHash
        ? { contentType: "image/png" as const, size: LOGO.byteLength, kind: "logo" as const }
        : null,
    ),
    read: vi.fn(async (site: string, hash: string) => {
      assetReads.push(`${site}/${hash}`);
      return site === siteId && hash === logoHash
        ? { contentType: "image/png" as const, size: LOGO.byteLength, kind: "logo" as const, bytes: LOGO.slice().buffer }
        : null;
    }),
  };
  const service = new DocsExportService({
    versions: { getPublishedVersionForUser },
    reader: createVersionTreeReader(storage.bucket),
    siteAssets,
    now: () => NOW,
  });
  return { storage, service, getPublishedVersionForUser, siteAssets, assetReads, logoHash };
}

async function collect(plan: DocsExportPlan, hooks: Parameters<Extract<DocsExportPlan, { kind: "ready" }>["open"]>[0] = {}) {
  if (plan.kind !== "ready") throw new Error(`plan is ${plan.kind}`);
  const response = new Response(plan.open(hooks));
  return new Uint8Array(await response.arrayBuffer());
}

describe("docs export service", () => {
  test("resolve the version from the owner and project only", async () => {
    const { service, getPublishedVersionForUser } = await setup();
    await service.prepare({ ownerUserId: "owner-1", projectId: "project-1" });
    expect(getPublishedVersionForUser).toHaveBeenCalledWith({ userId: "owner-1", projectId: "project-1" });
  });

  test("report a project without a published version", async () => {
    const { service } = await setup({ published: false });
    expect(await service.prepare({ ownerUserId: "o", projectId: "p" })).toEqual({ kind: "no_published_version" });
  });

  test("stream a zip with every page, image and setting, and a true export.json", async () => {
    const { service, logoHash } = await setup();
    const plan = await service.prepare({ ownerUserId: "o", projectId: "p" });
    expect(plan).toMatchObject({ kind: "ready", fileName: "acme-docs-2026-11-16.zip", fileCount: 7 });
    const onComplete = vi.fn();
    const files = unzipSync(await collect(plan, { onComplete }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(Object.keys(files).sort()).toEqual([
      "assets/diagram.png",
      "doxa.json",
      "export.json",
      "pages/guides/auth.mdx",
      "pages/index.mdx",
      "settings/sections.json",
      `site-assets/${logoHash}.png`,
    ]);
    expect(strFromU8(files["pages/guides/auth.mdx"]!)).toBe("# Auth\n");
    expect([...files[`site-assets/${logoHash}.png`]!]).toEqual([...LOGO]);
    const index = JSON.parse(strFromU8(files["export.json"]!));
    expect(index).toMatchObject({
      format: "doxa-docs-export",
      formatVersion: 1,
      exportedAt: NOW.toISOString(),
      project: { name: "Acme", slug: "acme" },
      version: { id: versionId, number: 7 },
    });
    for (const file of index.files) {
      expect(await sha256Hex(files[file.path]!)).toBe(file.sha256);
      expect(files[file.path]!.byteLength).toBe(file.size);
    }
  });

  test("read site assets of the resolved site only", async () => {
    const { service, siteAssets, assetReads } = await setup();
    await collect(await service.prepare({ ownerUserId: "o", projectId: "p" }));
    for (const call of siteAssets.head.mock.calls) expect(call[0]).toBe(siteId);
    expect(assetReads.every((read) => read.startsWith(`${siteId}/`))).toBe(true);
    expect(assetReads.some((read) => read.startsWith(otherSiteId))).toBe(false);
  });

  test("leave out a site asset that is gone", async () => {
    const { service } = await setup({ siteAssets: false });
    const files = unzipSync(await collect(await service.prepare({ ownerUserId: "o", projectId: "p" })));
    expect(Object.keys(files).some((path) => path.startsWith("site-assets/"))).toBe(false);
  });

  test("fail the stream when a stored file does not match its tree", async () => {
    const { service, storage } = await setup();
    const plan = await service.prepare({ ownerUserId: "o", projectId: "p" });
    const treeText = storage.text(`${prefix}/tree.json`)!;
    const entry = (JSON.parse(treeText) as VersionTree).files["source/index.mdx"]!;
    storage.objects.get(siteBlobKey(siteId, entry.sha256))!.bytes = new TextEncoder().encode("# Hack\n");
    const onError = vi.fn();
    const onComplete = vi.fn();
    await expect(collect(plan, { onError, onComplete })).rejects.toThrow(/sha256/);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  test("report a site above the size cap before any blob read", async () => {
    const { service, storage } = await setup();
    const treeKey = `${prefix}/tree.json`;
    const parsed = JSON.parse(storage.text(treeKey)!) as VersionTree;
    parsed.files["assets/diagram.png"]!.size = EXPORT_MAX_BYTES + 1;
    storage.objects.get(treeKey)!.bytes = new TextEncoder().encode(JSON.stringify(parsed));
    storage.resetCalls();
    const plan = await service.prepare({ ownerUserId: "o", projectId: "p" });
    expect(plan.kind).toBe("too_large");
    expect(storage.calls.get.filter((key) => key.includes("/blobs/")).length).toBeLessThanOrEqual(1);
  });

  test("open a plan only once", async () => {
    const { service } = await setup();
    const plan = await service.prepare({ ownerUserId: "o", projectId: "p" });
    if (plan.kind !== "ready") throw new Error("not ready");
    plan.open({});
    expect(() => plan.open({})).toThrow();
  });

  test("call onCancel and stop reads when the client leaves", async () => {
    const { service, storage } = await setup();
    const plan = await service.prepare({ ownerUserId: "o", projectId: "p" });
    if (plan.kind !== "ready") throw new Error("not ready");
    const onCancel = vi.fn();
    const onComplete = vi.fn();
    const stream = plan.open({ onCancel, onComplete });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    const readsAfterCancel = storage.calls.get.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storage.calls.get.length).toBe(readsAfterCancel);
  });
});

describe("docs export time limit", () => {
  test("stop the stream and call onCancel when the signal aborts", async () => {
    const { service } = await setup();
    const plan = await service.prepare({ ownerUserId: "o", projectId: "p" });
    if (plan.kind !== "ready") throw new Error("not ready");
    const controller = new AbortController();
    const onCancel = vi.fn();
    const onComplete = vi.fn();
    const reader = plan.open({ signal: controller.signal, onCancel, onComplete }).getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow(/stopped/);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("docs export idle limit", () => {
  test("stop the stream when the client reads nothing", async () => {
    vi.useFakeTimers();
    try {
      const { service } = await setup();
      const plan = await service.prepare({ ownerUserId: "o", projectId: "p" });
      if (plan.kind !== "ready") throw new Error("not ready");
      const onCancel = vi.fn();
      const reader = plan.open({ idleTimeoutMs: 1_000, onCancel }).getReader();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(onCancel).toHaveBeenCalledTimes(1);
      await expect(reader.read()).rejects.toThrow(/stopped/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("compress a file larger than one deflate piece correctly", async () => {
    const { createZipStream } = await import("../../src/services/docs-export/zip-stream");
    const text = "x".repeat(600 * 1024) + "end";
    const zip = createZipStream({
      files: [{ path: "pages/big.mdx", sha256: null, size: null, read: async () => new TextEncoder().encode(text) }],
      mtime: NOW,
    });
    const files = unzipSync(new Uint8Array(await new Response(zip).arrayBuffer()));
    expect(strFromU8(files["pages/big.mdx"]!)).toBe(text);
  });
});
