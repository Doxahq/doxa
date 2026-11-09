import { describe, expect, test, vi } from "vitest";
import { DOCS_ASSET_LIMITS } from "@doxahq/contracts/docs-assets";
import { branchIdSchema, versionIdSchema } from "@doxahq/contracts/docs-branches";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { resolveSiteConfig } from "@doxahq/site-config";
import {
  decodeAssetBase64,
  prepareDocsAsset,
} from "../../src/services/docs-branches/assets/asset-content";
import {
  assetBaseName,
  assetNameCandidates,
} from "../../src/services/docs-branches/assets/asset-name";
import {
  encodeBranchAssetPointer,
  parseBranchAssetPointer,
} from "../../src/services/docs-branches/assets/asset-pointer";
import {
  DocsBranchAssetUpload,
  type BranchAssetFolder,
} from "../../src/services/docs-branches/assets/asset-upload";
import { DocsBranchAssetRead } from "../../src/services/docs-branches/assets/asset-read";
import { DocsBranchDiffService } from "../../src/services/docs-branches/branch-diff";
import { createMaterializer } from "../../src/services/docs-branches/materialize";
import { computeSyncPlan } from "../../src/services/docs-branches/sync-plan";
import { prepareWorkingChanges } from "../../src/services/docs-branches/working-changes";
import { DocsContentError } from "../../src/services/docs-content/errors";
import type { ImageCompressor } from "../../src/services/site-assets/image-compression";
import type { SvgCleaner } from "../../src/services/site-assets/image-content";
import type { DocsContentStore } from "../../src/services/docs-content/store";
import {
  BASE_PREFIX,
  BASE_VERSION_ID,
  BRANCH_ID,
  createBranchContentFixture,
  NEXT_VERSION_ID,
  SITE_ID,
} from "../support/branch-content-fixture";

const encode = (text: string) => new TextEncoder().encode(text);

function png(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes[size - 1] = size % 251;
  return bytes;
}
const jpeg = () => Uint8Array.from([255, 216, 255, 224, 0, 16, 74, 70]);
const webp = () =>
  Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]);
const gif = () => encode("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000");
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;

function expectError(run: () => unknown, code: DocsContentError["code"]) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DocsContentError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}.`);
}

async function expectRejection(
  promise: Promise<unknown>,
  code: DocsContentError["code"],
) {
  await expect(promise).rejects.toBeInstanceOf(DocsContentError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("image type detection", () => {
  test.each([
    ["PNG", png(), "image/png", "png"],
    ["JPEG", jpeg(), "image/jpeg", "jpg"],
    ["WebP", webp(), "image/webp", "webp"],
    ["GIF", gif(), "image/gif", "gif"],
  ])("detects %s from its bytes", (_name, bytes, contentType, extension) => {
    expect(prepareDocsAsset(bytes)).toEqual({
      bytes,
      contentType,
      extension,
      sanitized: false,
    });
  });

  test.each([
    ["plain text", encode("hello, this is not an image")],
    ["HTML", encode("<html><script>alert(1)</script></html>")],
    ["a truncated PNG signature", Uint8Array.from([137, 80, 78, 71])],
    ["an icon", Uint8Array.from([0, 0, 1, 0, 1, 0, ...new Array(16).fill(0)])],
    ["invalid UTF-8", Uint8Array.from([0xff, 0xfe, 0x3c, 0x73, 0x76, 0x67])],
    ["an empty file", new Uint8Array()],
  ])("rejects %s whatever its name", (_name, bytes) => {
    expectError(() => prepareDocsAsset(bytes), "asset_invalid");
  });

  test("caps a file at 2 MB of decoded bytes", () => {
    expect(prepareDocsAsset(png(DOCS_ASSET_LIMITS.maxBytes)).contentType).toBe(
      "image/png",
    );
    expectError(
      () => prepareDocsAsset(png(DOCS_ASSET_LIMITS.maxBytes + 1)),
      "asset_too_large",
    );
  });

  test("decodes standard base64 and refuses anything else", () => {
    expect(decodeAssetBase64(btoa("GIF89a"))).toEqual(encode("GIF89a"));
    expect(
      decodeAssetBase64(
        `${btoa("GIF89a").slice(0, 4)}\n${btoa("GIF89a").slice(4)}`,
      ),
    ).toEqual(encode("GIF89a"));
    expectError(
      () => decodeAssetBase64("data:image/png;base64,AAAA"),
      "asset_invalid",
    );
    expectError(() => decodeAssetBase64("abc"), "asset_invalid");
  });

  test("refuses oversized base64 before decoding it", () => {
    const atob = vi.spyOn(globalThis, "atob");
    const length = Math.ceil((DOCS_ASSET_LIMITS.maxBytes + 3) / 3) * 4;
    expectError(() => decodeAssetBase64("A".repeat(length)), "asset_too_large");
    expect(atob).not.toHaveBeenCalled();
    atob.mockRestore();
  });
});

describe("SVG cleaning", () => {
  test.each([
    ["a script", '<script>alert(1)</script><path d="M0 0"/>', "script"],
    ["an event attribute", '<path onload="alert(1)" d="M0 0"/>', "onload"],
    [
      "an external href",
      '<use href="https://evil.test/x.svg#a"/>',
      "evil.test",
    ],
    [
      "an external xlink:href",
      '<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://evil.test/x"/>',
      "evil.test",
    ],
    [
      "a foreignObject",
      "<foreignObject><div>html</div></foreignObject>",
      "foreignObject",
    ],
    [
      "a javascript: URL",
      '<a href="javascript:alert(1)"><path d="M0 0"/></a>',
      "javascript",
    ],
    ["a javascript: use", '<use href="javascript:alert(1)"/>', "javascript"],
    [
      "a style @import",
      '<style>@import "https://evil.test/a.css";</style>',
      "import",
    ],
    [
      "a style url()",
      "<style>.a { fill: url(http://evil.test/x) }</style>",
      "evil.test",
    ],
    [
      "an external image",
      '<image href="https://evil.test/x.png"/>',
      "evil.test",
    ],
  ])("removes %s and reports the change", (_name, body, removed) => {
    const result = prepareDocsAsset(encode(svg(body)));
    const output = new TextDecoder().decode(result.bytes);

    expect(result).toMatchObject({
      contentType: "image/svg+xml",
      extension: "svg",
      sanitized: true,
    });
    expect(output).not.toContain(removed);
    expect(output).toMatch(/^<svg/);
  });

  test("drops an external stylesheet instruction beside the root", () => {
    const result = prepareDocsAsset(
      encode(`<?xml-stylesheet href="https://evil.test/a.css"?>${svg("")}`),
    );
    expect(result.sanitized).toBe(true);
    expect(new TextDecoder().decode(result.bytes)).not.toContain("evil.test");
  });

  test("keeps a clean diagram unchanged", () => {
    const clean = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Exported diagram -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 40">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#333"/>
    </marker>
  </defs>
  <rect x="1" y="1" width="30" height="20" fill="none" stroke="#333"/>
  <line x1="31" y1="11" x2="70" y2="11" stroke="#333" marker-end="url(#arrow)"/>
  <use xlink:href="#arrow"/>
  <text x="72" y="15" font-family="sans-serif" font-size="8">API</text>
</svg>`;
    const result = prepareDocsAsset(encode(clean));
    const output = new TextDecoder().decode(result.bytes);

    expect(result.sanitized).toBe(false);
    expect(output).toContain('<marker id="arrow"');
    expect(output).toContain('marker-end="url(#arrow)"');
    expect(output).toContain('xlink:href="#arrow"');
  });

  test("rejects an SVG with entities and a non-SVG XML document", () => {
    expectError(
      () =>
        prepareDocsAsset(
          encode('<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>'),
        ),
      "asset_invalid",
    );
    expectError(() => prepareDocsAsset(encode("<html/>")), "asset_invalid");
  });
});

describe("image names", () => {
  test.each([
    ["rate-limits-diagram.png", "rate-limits-diagram"],
    ["Rate Limits (v2).PNG", "rate-limits-v2"],
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\me\\Café Menu.jpeg", "cafe-menu"],
    ["___.png", "image"],
    [".png", "png"],
    [`${"a".repeat(100)}.png`, "a".repeat(60)],
  ])("turns %j into the slug %j", (fileName, slug) => {
    expect(assetBaseName(fileName)).toBe(slug);
  });

  test("suffixes a name in use and keeps every candidate valid", () => {
    const names = assetNameCandidates("a".repeat(60), "png");
    expect(names.next().value).toBe(`${"a".repeat(60)}.png`);
    expect(names.next().value).toBe(`${"a".repeat(58)}-2.png`);
  });
});

function uploadFixture(
  options: { maxDocsStorageBytes?: number; compressor?: ImageCompressor; svgCleaner?: SvgCleaner } = {},
) {
  const fixture = createBranchContentFixture();
  const registered: BranchAssetFolder[] = [];
  let next = 0;
  const upload = new DocsBranchAssetUpload({
    branches: fixture.branches,
    store: fixture.store,
    storageLimits: {
      getStorageLimits: async () => ({
        maxDocsStorageBytes: options.maxDocsStorageBytes ?? 100 * 1024 * 1024,
        maxSiteAssetBytes: 50 * 1024 * 1024,
        maxSiteAssetFiles: 200,
      }),
    },
    registerFolder: async (folder) => {
      registered.push(folder);
    },
    compressor: options.compressor ?? null,
    svgCleaner: options.svgCleaner ?? null,
    createId: () =>
      `20000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
  });
  const send = (fileName: string, bytes: Uint8Array) =>
    upload.upload({ ...fixture.scope, origin: "mcp", fileName, bytes });
  return { ...fixture, registered, send, upload };
}

describe("branch image upload", () => {
  test("stores the compressed file under the name of its real type", async () => {
    const compressed = webp();
    const compress = vi.fn(async () => ({ bytes: compressed, contentType: "image/webp" as const }));
    const { send, objects, registered, branches, scope } = uploadFixture({ compressor: { compress } });

    const result = await send("Rate limits.png", png(64));

    expect(result).toMatchObject({
      path: "/assets/rate-limits.webp",
      contentType: "image/webp",
      size: compressed.byteLength,
      sanitized: false,
    });
    expect(compress).toHaveBeenCalledWith(expect.objectContaining({ contentType: "image/png", profile: "docs_image" }));
    const folderPrefix = buildArtifactPrefix(SITE_ID, registered[0]!.versionId);
    expect(objects.get(`${folderPrefix}/assets/rate-limits.webp`)).toEqual(compressed);
    expect(objects.has(`${folderPrefix}/assets/rate-limits.png`)).toBe(false);
    const [change] = await branches.listChanges(scope);
    expect(change).toMatchObject({ path: "assets/rate-limits.webp", kind: "upsert" });
  });

  test("a re-upload of the same image returns the path it has", async () => {
    const compress = vi.fn(async () => ({ bytes: webp(), contentType: "image/webp" as const }));
    const { send } = uploadFixture({ compressor: { compress } });

    const first = await send("diagram.png", png(64));
    const second = await send("diagram.png", png(64));

    expect(second).toMatchObject({ path: first.path, reused: true });
  });

  test("stores the original when compression fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const compress = vi.fn(() => Promise.reject(new Error("no origin")));
    const { send } = uploadFixture({ compressor: { compress } });
    const bytes = png(64);

    await expect(send("diagram.png", bytes)).resolves.toMatchObject({
      path: "/assets/diagram.png",
      contentType: "image/png",
      size: bytes.byteLength,
    });
    warn.mockRestore();
  });

  test("refuses a bad file before it reaches the encoder", async () => {
    const compress = vi.fn(async () => null);
    const { send } = uploadFixture({ compressor: { compress } });

    await expectRejection(send("notes.png", encode("plain text")), "asset_invalid");
    expect(compress).not.toHaveBeenCalled();
  });

  test("stores the image as a branch change through a version folder", async () => {
    const { send, branches, scope, objects, registered } = uploadFixture();
    const bytes = png();

    const result = await send("Rate limits diagram.png", bytes);

    expect(result).toEqual({
      path: "/assets/rate-limits-diagram.png",
      contentType: "image/png",
      size: bytes.byteLength,
      sanitized: false,
      reused: false,
      revision: 2,
    });
    const folderPrefix = buildArtifactPrefix(SITE_ID, registered[0]!.versionId);
    expect(registered).toEqual([
      {
        siteId: SITE_ID,
        versionId: registered[0]!.versionId,
        branchId: BRANCH_ID,
      },
    ]);
    expect(
      objects.get(`${folderPrefix}/assets/rate-limits-diagram.png`),
    ).toEqual(bytes);
    const [change] = await branches.listChanges(scope);
    expect(change).toMatchObject({
      path: "assets/rate-limits-diagram.png",
      kind: "upsert",
      origin: "mcp",
    });
    expect(
      parseBranchAssetPointer(change!.kind === "upsert" ? change!.content : ""),
    ).toMatchObject({
      folderVersionId: registered[0]!.versionId,
      size: bytes.byteLength,
      contentType: "image/png",
    });
    // Nothing goes live: main still has no image.
    expect(
      [...objects.keys()].some((key) =>
        key.startsWith(`${BASE_PREFIX}/assets/`),
      ),
    ).toBe(false);
  });

  test("names the file after its detected type, not its claimed one", async () => {
    const { send } = uploadFixture();
    expect((await send("photo.png", jpeg())).path).toBe("/assets/photo.jpg");
  });

  test("suffixes a name that the branch or main already uses", async () => {
    const { send, objects } = uploadFixture();
    objects.set(`${BASE_PREFIX}/assets/logo.png`, "published logo");

    expect((await send("logo.png", png(50))).path).toBe("/assets/logo-2.png");
    expect((await send("logo.png", png(60))).path).toBe("/assets/logo-3.png");
  });

  test("returns the existing path for the same file again", async () => {
    const { send, registered } = uploadFixture();
    await send("chart.png", png());

    expect(await send("chart.png", png())).toMatchObject({
      path: "/assets/chart.png",
      reused: true,
      revision: 2,
    });
    expect(registered).toHaveLength(1);
  });

  test("allows 50 images on one branch", async () => {
    const { send } = uploadFixture();
    for (let index = 0; index < DOCS_ASSET_LIMITS.maxFilesPerBranch; index++) {
      await send(`image-${index}.png`, png(32 + index));
    }

    await expectRejection(
      send("one-more.png", png(200)),
      "asset_limit_reached",
    );
  });

  test("counts the version and the branch images against the plan storage", async () => {
    const fixture = createBranchContentFixture();
    const versionBytes = (await fixture.store.versionSize(BASE_PREFIX)) ?? 0;
    const { send } = uploadFixture({ maxDocsStorageBytes: versionBytes + 100 });

    await send("first.png", png(60));
    await expectRejection(
      send("second.png", png(60)),
      "storage_quota_exceeded",
    );
  });

  describe("the plan storage covers the whole site", () => {
    const OTHER_BRANCH = "10000000-0000-4000-8000-000000000099";
    const OLD_VERSION = "10000000-0000-4000-8000-000000000098";

    async function twoBranches(maxExtraBytes: number, otherBase?: string) {
      const versionBytes = await createBranchContentFixture().store.versionSize(BASE_PREFIX);
      const fixture = uploadFixture({
        maxDocsStorageBytes: (versionBytes ?? 0) + maxExtraBytes,
      });
      const first = await fixture.branches.getBranchForUser(fixture.scope);
      if (!first) throw new Error("The fixture has no branch.");
      fixture.branches.addBranch({
        ...first,
        kind: "named",
        id: branchIdSchema.parse(OTHER_BRANCH),
        name: "agent-other",
        revision: 1,
        ...(otherBase ? { baseVersionId: versionIdSchema.parse(otherBase) } : {}),
      });
      if (otherBase) {
        fixture.branches.addVersion(otherBase, buildArtifactPrefix(SITE_ID, otherBase));
      }
      const sendTo = (branch: string, fileName: string, bytes: Uint8Array) =>
        fixture.upload.upload({ ...fixture.scope, branch, origin: "mcp", fileName, bytes });
      return { ...fixture, sendTo };
    }

    test("counts the images of every branch", async () => {
      const { sendTo } = await twoBranches(100);
      await sendTo(BRANCH_ID, "first.png", png(60));
      await expectRejection(sendTo(OTHER_BRANCH, "second.png", png(60)), "storage_quota_exceeded");
    });

    test("allows a file that fills the plan exactly and refuses one byte more", async () => {
      const { sendTo } = await twoBranches(100);
      await sendTo(BRANCH_ID, "first.png", png(60));
      await expectRejection(sendTo(OTHER_BRANCH, "over.png", png(41)), "storage_quota_exceeded");
      await expect(sendTo(OTHER_BRANCH, "fits.png", png(40))).resolves.toBeDefined();
    });

    test("measures the published version, not an older base of the branch", async () => {
      const { sendTo } = await twoBranches(10, OLD_VERSION);
      await expectRejection(sendTo(OTHER_BRANCH, "first.png", png(60)), "storage_quota_exceeded");
    });

    test("a deleted branch gives its storage back", async () => {
      const { sendTo, branches } = await twoBranches(100);
      await sendTo(BRANCH_ID, "first.png", png(60));
      branches.setChanges(BRANCH_ID, []);
      await expect(sendTo(OTHER_BRANCH, "second.png", png(60))).resolves.toBeDefined();
    });

    test("writes no file when the plan is full", async () => {
      const { sendTo, registered } = await twoBranches(100);
      await sendTo(BRANCH_ID, "first.png", png(60));
      registered.length = 0;
      await expectRejection(sendTo(OTHER_BRANCH, "second.png", png(60)), "storage_quota_exceeded");
      expect(registered).toEqual([]);
    });

    test("hands the budget to the write, which checks it under the site lock", async () => {
      const { sendTo, branches } = await twoBranches(100);
      const write = vi.spyOn(branches, "writeChanges");
      await sendTo(BRANCH_ID, "first.png", png(60));
      expect(write.mock.calls[0]?.[0].assetQuota).toEqual({ addedBytes: 60, maxBytes: 100 });
    });

    test("refuses when a parallel upload took the last bytes first", async () => {
      const { sendTo, branches, scope } = await twoBranches(100);
      vi.spyOn(branches, "writeChanges").mockResolvedValueOnce("storage_quota_exceeded");
      await expectRejection(sendTo(BRANCH_ID, "first.png", png(60)), "storage_quota_exceeded");
      expect(await branches.listChanges(scope)).toEqual([]);
    });

    test("stores nothing when the site lock stays busy", async () => {
      const { sendTo, branches, scope } = await twoBranches(100);
      vi.spyOn(branches, "writeChanges").mockResolvedValueOnce("quota_busy");
      await expectRejection(sendTo(BRANCH_ID, "first.png", png(60)), "asset_upload_busy");
      expect(await branches.listChanges(scope)).toEqual([]);
    });

    test("counts a copied branch once: its rows share one stored file", async () => {
      const { sendTo, branches, scope } = await twoBranches(100);
      await sendTo(BRANCH_ID, "first.png", png(60));
      branches.setChanges(OTHER_BRANCH, await branches.listChanges(scope));
      await expect(sendTo(OTHER_BRANCH, "fits.png", png(40))).resolves.toBeDefined();
    });

    test("reports the whole plan in the refusal", async () => {
      const { sendTo } = await twoBranches(100);
      await sendTo(BRANCH_ID, "first.png", png(60));
      const versionBytes = await createBranchContentFixture().store.versionSize(BASE_PREFIX);
      await expect(sendTo(OTHER_BRANCH, "second.png", png(60))).rejects.toMatchObject({
        code: "storage_quota_exceeded",
        details: { usedBytes: (versionBytes ?? 0) + 60, limitBytes: (versionBytes ?? 0) + 100 },
      });
    });
  });

  test("sends an SVG file to the isolated cleaner, and stores nothing without a result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fixture = uploadFixture({
      svgCleaner: { clean: () => Promise.reject(new Error("timed out")) },
    });
    await expectRejection(fixture.send("a.svg", encode(svg(""))), "asset_upload_busy");
    expect(fixture.registered).toEqual([]);
    warn.mockRestore();
  });

  test("rejects a spoofed file before any write", async () => {
    const { send, registered, branches, scope } = uploadFixture();
    await expectRejection(
      send("diagram.png", encode("<html>not an image</html>")),
      "asset_invalid",
    );
    expect(registered).toEqual([]);
    expect(await branches.listChanges(scope)).toEqual([]);
  });

  test("an upload to main goes to the caller's hidden branch", async () => {
    const { branches, scope, registered, ...fixture } = uploadFixture();
    const mainScope = { ...scope, branch: "main" };
    const upload = (bytes: Uint8Array) =>
      fixture.upload.upload({
        ...mainScope,
        origin: "editor",
        fileName: "screenshot.png",
        bytes,
      });
    const bytes = png();

    const first = await upload(bytes);
    const again = await upload(bytes);

    expect(first).toMatchObject({
      path: "/assets/screenshot.png",
      reused: false,
    });
    expect(again).toMatchObject({ path: "/assets/screenshot.png", reused: true });
    const hidden = await branches.resolveForUser(mainScope);
    expect(hidden?.branch?.kind).toBe("hidden");
    expect(registered).toEqual([
      expect.objectContaining({ branchId: hidden?.branch?.id }),
    ]);
    expect(await branches.listChanges(mainScope)).toEqual([
      expect.objectContaining({
        path: "assets/screenshot.png",
        origin: "editor",
      }),
    ]);
    // The named branch of the fixture is untouched.
    expect(await branches.listChanges(scope)).toEqual([]);
  });
});

describe("branch image read", () => {
  function readFixture() {
    const fixture = uploadFixture();
    const reader = new DocsBranchAssetRead({
      branches: fixture.branches,
      store: fixture.store,
    });
    const read = (branch: string, name: string) =>
      reader.read({ ...fixture.scope, branch, name });
    return { ...fixture, read };
  }

  test("reads the upload of the branch", async () => {
    const { send, read } = readFixture();
    const bytes = png();
    await send("diagram.png", bytes);

    expect(await read(BRANCH_ID, "diagram.png")).toEqual({
      bytes,
      contentType: "image/png",
    });
  });

  test("falls back to the base version for a name the branch does not add", async () => {
    const { objects, read } = readFixture();
    const bytes = png(32);
    objects.set(`${BASE_PREFIX}/assets/logo.png`, bytes);

    expect(await read(BRANCH_ID, "logo.png")).toEqual({
      bytes,
      contentType: "image/png",
    });
    // main without a hidden branch reads the published version.
    expect(await read("main", "logo.png")).toEqual({
      bytes,
      contentType: "image/png",
    });
  });

  test("returns null for a missing file or a name that is not an image", async () => {
    const { read } = readFixture();

    expect(await read(BRANCH_ID, "missing.png")).toBeNull();
    expect(await read(BRANCH_ID, "manifest.json")).toBeNull();
    expect(await read(BRANCH_ID, "../manifest.json")).toBeNull();
  });
});

describe("branch images in publish, preview, diff and sync", () => {
  async function branchWithImage() {
    const fixture = uploadFixture();
    const bytes = png(80);
    await fixture.send("flow.png", bytes);
    const changes = await fixture.branches.listChanges(fixture.scope);
    return { ...fixture, bytes, changes };
  }

  function materialize(
    store: DocsContentStore,
    changes: Awaited<ReturnType<typeof branchWithImage>>["changes"],
    target = NEXT_VERSION_ID,
  ) {
    return createMaterializer({ store })({
      siteId: SITE_ID,
      base: { versionId: BASE_VERSION_ID, artifactPrefix: BASE_PREFIX },
      changes,
      targetVersionId: target,
      generatedAt: "2026-10-05T02:00:00.000Z",
      siteConfig: resolveSiteConfig({ name: "Example" }),
    });
  }

  test("a publish or a preview build carries the image into the new version", async () => {
    const { store, objects, changes, bytes } = await branchWithImage();

    const result = await materialize(store, changes);

    expect(objects.get(`${result.artifactPrefix}/assets/flow.png`)).toEqual(
      bytes,
    );
    expect(result.summary).toMatchObject({ changedPageCount: 0 });
  });

  test("a later version keeps a published image", async () => {
    const { store, objects, changes, bytes } = await branchWithImage();
    const first = await materialize(store, changes);
    const laterBase = first.artifactPrefix;
    const later = await createMaterializer({ store })({
      siteId: SITE_ID,
      base: { versionId: NEXT_VERSION_ID, artifactPrefix: laterBase },
      changes: [],
      targetVersionId: "10000000-0000-4000-8000-000000000099",
      generatedAt: "2026-10-05T03:00:00.000Z",
      siteConfig: resolveSiteConfig({ name: "Example" }),
    });

    expect(objects.get(`${later.artifactPrefix}/assets/flow.png`)).toEqual(
      bytes,
    );
  });

  test("the branch diff lists the image as added, without a text diff", async () => {
    const { branches, store, scope, bytes, objects } = await branchWithImage();
    const service = new DocsBranchDiffService(branches, store);
    const reads = vi.spyOn(store, "read");

    const diff = await service.diff(scope);

    expect(diff.assets).toEqual([
      {
        path: "/assets/flow.png",
        change: "added",
        contentType: "image/png",
        size: bytes.byteLength,
      },
    ]);
    expect(diff.pages).toEqual([]);
    expect(reads.mock.calls.some(([key]) => key.includes("/assets/"))).toBe(
      false,
    );
    expect(objects.size).toBeGreaterThan(0);
  });

  test("a sync keeps the branch image and reads no image", async () => {
    const pointer = encodeBranchAssetPointer({
      folderVersionId: "20000000-0000-4000-8000-000000000001",
      sha256: "a".repeat(64),
      size: 10,
      contentType: "image/png",
    });
    const plan = computeSyncPlan({
      changes: [
        { path: "assets/flow.png", base: null, main: "other", mine: pointer },
      ],
      mainChangedStructurePaths: new Set(),
    });
    expect(plan.decisions.get("assets/flow.png")).toBe("keep_change");
    expect(plan.conflicts).toEqual([]);

    const read = vi.fn(async () => "main image bytes");
    const writes = await prepareWorkingChanges({
      store: { read },
      basePrefix: BASE_PREFIX,
      existing: [],
      desired: new Map([["assets/flow.png", pointer]]),
    });
    expect(read).not.toHaveBeenCalled();
    expect(writes).toEqual([
      expect.objectContaining({
        path: "assets/flow.png",
        kind: "upsert",
        content: pointer,
      }),
    ]);
  });
});
