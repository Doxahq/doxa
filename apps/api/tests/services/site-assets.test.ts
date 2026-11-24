import { describe, expect, test, vi } from "vitest";
import { SITE_ASSET_MAX_BYTES, type SiteAssetKind } from "@doxahq/site-config";
import { siteAssetUploadResponseSchema } from "@doxahq/contracts/site-assets";
import { prepareSiteAsset } from "../../src/services/site-assets/content";
import { sanitizeSvg } from "../../src/services/site-assets/svg";
import type { ImageCompressor } from "../../src/services/site-assets/image-compression";
import type { SvgCleaner } from "../../src/services/site-assets/image-content";
import { SiteAssetsService } from "../../src/services/site-assets/service";
import { SiteConfigValidationError } from "../../src/services/site-config-validation";
import type {
  SiteAssetMetadata,
  SiteAssetStore,
} from "../../src/services/site-assets/store";

const encode = (text: string) => new TextEncoder().encode(text);
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
function png(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
}

describe("SVG allowlist", () => {
  test.each([
    ["script", "<script>alert(1)</script>", "script"],
    [
      "foreignObject",
      "<foreignObject><div>html</div></foreignObject>",
      "foreignObject",
    ],
    ["event", '<path onload="alert(1)" d="M0 0"/>', "onload"],
    ["external href", '<use href="https://evil.test/x"/>', "evil.test"],
    [
      "xlink",
      '<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="javascript:alert(1)"/>',
      "javascript",
    ],
    [
      "namespace",
      '<script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script>',
      "script",
    ],
    [
      "animation",
      '<animate attributeName="href" values="javascript:alert(1)"/>',
      "animate",
    ],
    ["import", '<style>@import "https://evil.test/style";</style>', "style"],
    [
      "CSS url",
      "<style>.a { fill: url(https://evil.test/x) }</style>",
      "style",
    ],
    [
      "CSS image-set",
      '<style>.a { background: image-set("https://evil.test/x" 1x) }</style>',
      "style",
    ],
    [
      "CSS escape",
      "<style>.a { fill: u\\72l(https://evil.test/x) }</style>",
      "style",
    ],
    ["paint server", '<path fill="url(https://evil.test/x)"/>', "evil.test"],
    [
      "attribute entity",
      '<path style="fill:u&#114;l(https://evil.test/x)"/>',
      "evil.test",
    ],
  ])("removes %s", (_name, input, removed) => {
    const output = sanitizeSvg(svg(input));
    expect(output).not.toContain(removed);
    expect(output).toMatch(/^<svg/);
  });
  test.each([
    '<!DOCTYPE svg [<!ENTITY x "hello">]><svg>&x;</svg>',
    '<!DOCTYPE svg SYSTEM "https://evil.test/x"><svg/>',
    "<svg><path></svg>",
    "<html/>",
    '<svg xmlns="https://evil.test"/>',
  ])("rejects malformed or entity-bearing XML: %s", (input) => {
    expect(() => sanitizeSvg(input)).toThrow();
  });
  test("keeps safe shapes and local gradients", () => {
    const input = svg(
      '<defs><linearGradient id="a"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0" fill="url(#a)"/><use href="#a"/><style>.a {fill: red}</style>',
    );
    expect(sanitizeSvg(input)).toBe(input);
  });
  test("is idempotent across generated safe shapes", () => {
    for (let size = 1; size <= 100; size++) {
      const output = sanitizeSvg(
        svg(`<circle cx="${size}" cy="2" r="1"/><path onload="bad()"/>`),
      );
      expect(sanitizeSvg(output)).toBe(output);
    }
  });
});

describe("asset preparation", () => {
  const kinds: SiteAssetKind[] = ["logo", "favicon", "ogImage"];
  for (const kind of kinds) {
    test.each([-1, 0, 1])(`${kind} size boundary %+d`, (delta) => {
      const run = () =>
        prepareSiteAsset(png(SITE_ASSET_MAX_BYTES[kind] + delta), kind);
      if (delta > 0)
        expect(run).toThrow(
          expect.objectContaining({
            issues: [expect.objectContaining({ code: "asset_too_large" })],
          }),
        );
      else expect(run().contentType).toBe("image/png");
    });
  }
  test.each(["not an image", "GIF89a", "<html>fake.png</html>"])(
    "rejects wrong magic bytes: %s",
    (input) => {
      expect(() => prepareSiteAsset(encode(input), "logo")).toThrow(
        expect.objectContaining({
          issues: [expect.objectContaining({ code: "asset_unsupported_type" })],
        }),
      );
    },
  );
  test("does not report a clean SVG that only serializes differently", () => {
    const output = prepareSiteAsset(
      encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><!-- logo --><path d="M0 0"/></svg>'),
      "logo",
    );
    expect(output.sanitized).toBe(false);
  });
  test("reports sanitized SVG bytes", () => {
    const output = prepareSiteAsset(
      encode(svg('<script>alert(1)</script><path d="M0 0"/>')),
      "logo",
    );
    expect(output.sanitized).toBe(true);
    expect(new TextDecoder().decode(output.bytes)).not.toContain("script");
  });
});

const LIMITS = {
  maxDocsStorageBytes: 100 * 1024 * 1024,
  maxSiteAssetBytes: 1_000,
  maxSiteAssetFiles: 3,
};

function fixture(
  options: {
    compressor?: ImageCompressor | null;
    svgCleaner?: SvgCleaner | null;
    limits?: typeof LIMITS;
  } = {},
) {
  const entries = new Map<string, SiteAssetMetadata & { bytes: ArrayBuffer }>();
  const store: SiteAssetStore = {
    async head(site, hash) {
      return entries.get(`${site}/${hash}`) ?? null;
    },
    async read(site, hash) {
      return entries.get(`${site}/${hash}`) ?? null;
    },
    write: vi.fn(async (site, hash, bytes, metadata) => {
      entries.set(`${site}/${hash}`, {
        ...metadata,
        bytes: Uint8Array.from(bytes).buffer,
      });
    }),
    async usage(site) {
      const stored = [...entries].filter(([key]) => key.startsWith(`${site}/`));
      return {
        files: stored.length,
        bytes: stored.reduce((sum, [, entry]) => sum + entry.bytes.byteLength, 0),
      };
    },
  };
  // Like the database lock: one upload of a site at a time.
  let lastUpload: Promise<unknown> = Promise.resolve();
  let lockCount = 0;
  const sites = {
    getDocsSiteForUser: vi.fn(async (user: string, project: string) =>
      user === "owner" ? { siteId: project } : null,
    ),
    withSiteAssetLock<T>(_site: string, work: () => Promise<T>): Promise<T> {
      lockCount += 1;
      const run = lastUpload.then(work, work);
      lastUpload = run.catch(() => undefined);
      return run;
    },
  };
  const service = new SiteAssetsService({
    sites,
    store,
    storageLimits: { getStorageLimits: async () => options.limits ?? LIMITS },
    compressor: options.compressor ?? null,
    svgCleaner: options.svgCleaner ?? null,
  });
  return { store, entries, service, lockCount: () => lockCount };
}

const uniquePng = (seed: number, size = 64) => {
  const bytes = png(size);
  bytes[size - 1] = seed;
  return bytes;
};

describe("site asset quota", () => {
  test("refuses a new file when the file count is full", async () => {
    const { service, store } = fixture();
    for (const seed of [1, 2, 3]) await service.upload("owner", "site", "logo", uniquePng(seed));

    await expect(service.upload("owner", "site", "logo", uniquePng(4))).rejects.toMatchObject({
      code: "plan_limit",
      details: { key: "site.asset_files", limit: 3, used: 3 },
    });
    expect(store.write).toHaveBeenCalledTimes(3);
  });

  test("allows a file that fills the byte limit exactly and refuses one byte more", async () => {
    const limits = { ...LIMITS, maxSiteAssetFiles: 10 };
    const { service } = fixture({ limits });
    await service.upload("owner", "site", "logo", uniquePng(1, 600));

    await expect(service.upload("owner", "site", "logo", uniquePng(2, 401))).rejects.toMatchObject({
      code: "plan_limit",
      details: { key: "site.asset_bytes" },
    });
    await expect(service.upload("owner", "site", "logo", uniquePng(3, 400))).resolves.toBeDefined();
  });

  test("a repeated upload of a stored file needs no quota", async () => {
    const { service, store } = fixture();
    for (const seed of [1, 2, 3]) await service.upload("owner", "site", "logo", uniquePng(seed));

    await expect(service.upload("owner", "site", "logo", uniquePng(2))).resolves.toBeDefined();
    expect(store.write).toHaveBeenCalledTimes(3);
  });

  test("counts each site apart", async () => {
    const { service } = fixture();
    for (const seed of [1, 2, 3]) await service.upload("owner", "site-a", "logo", uniquePng(seed));
    await expect(service.upload("owner", "site-b", "logo", uniquePng(9))).resolves.toBeDefined();
  });

  test("parallel uploads store exactly the limit", async () => {
    const limits = { ...LIMITS, maxSiteAssetFiles: 5, maxSiteAssetBytes: 1_000_000 };
    const { service, store } = fixture({ limits });

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, seed) => service.upload("owner", "site", "logo", uniquePng(seed))),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(store.write).toHaveBeenCalledTimes(5);
  });

  test("checks the stored size after compression, inside the lock", async () => {
    const compressed = Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]);
    const compressor: ImageCompressor = {
      compress: async () => ({ bytes: compressed, contentType: "image/webp" }),
    };
    const limits = { ...LIMITS, maxSiteAssetBytes: compressed.byteLength };
    const { service, lockCount } = fixture({ compressor, limits });

    await expect(service.upload("owner", "site", "logo", png(5_000))).resolves.toBeDefined();
    expect(lockCount()).toBe(1);
  });
});

describe("generation site assets", () => {
  test("stores an asset for a generation without a user lookup", async () => {
    const { service, entries } = fixture();
    const stored = await service.uploadForGeneration("project", "site", "logo", uniquePng(1));
    expect(stored.ref).toMatch(/^asset:[a-f0-9]{64}$/);
    expect([...entries.keys()]).toEqual([`site/${stored.ref.slice("asset:".length)}`]);
  });

  test("counts generation assets against the same site quota", async () => {
    const { service, store } = fixture();
    for (const seed of [1, 2, 3]) await service.upload("owner", "site", "logo", uniquePng(seed));
    await expect(
      service.uploadForGeneration("project", "site", "logo", uniquePng(4)),
    ).rejects.toMatchObject({ code: "plan_limit", details: { key: "site.asset_files" } });
    expect(store.write).toHaveBeenCalledTimes(3);
  });

  test("cleans a generation SVG like an upload", async () => {
    const { service, entries } = fixture();
    await service.uploadForGeneration(
      "project",
      "site",
      "logo",
      encode(svg('<script>alert(1)</script><path d="M0 0h1"/>')),
    );
    const [entry] = [...entries.values()];
    expect(new TextDecoder().decode(entry.bytes)).not.toContain("script");
  });
});

describe("SVG cleaning away from the API thread", () => {
  const svgBytes = () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

  test("sends SVG files to the cleaner, and stores what it returns", async () => {
    const cleaned = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');
    const clean = vi.fn(async () => ({ bytes: cleaned, removedCount: 1 }));
    const { service, entries } = fixture({ svgCleaner: { clean } });

    const result = await service.upload("owner", "site", "logo", svgBytes());

    expect(clean).toHaveBeenCalledWith(expect.objectContaining({ profile: "site" }));
    expect(result).toMatchObject({ contentType: "image/svg+xml", size: cleaned.byteLength });
    expect(result.warnings).toHaveLength(1);
    expect(new Uint8Array([...entries.values()][0]!.bytes)).toEqual(cleaned);
  });

  test("never sends a raster file to the cleaner", async () => {
    const clean = vi.fn(async () => null);
    const { service } = fixture({ svgCleaner: { clean } });
    await service.upload("owner", "site", "logo", png(64));
    expect(clean).not.toHaveBeenCalled();
  });

  test("refuses a file that the cleaner rejects as invalid", async () => {
    const { service, store } = fixture({ svgCleaner: { clean: async () => null } });
    await expect(service.upload("owner", "site", "logo", svgBytes())).rejects.toBeInstanceOf(
      SiteConfigValidationError,
    );
    expect(store.write).not.toHaveBeenCalled();
  });

  test("stores nothing when the cleaner gives no result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, store } = fixture({
      svgCleaner: { clean: () => Promise.reject(new Error("timed out")) },
    });
    await expect(service.upload("owner", "site", "logo", svgBytes())).rejects.toMatchObject({
      code: "asset_upload_busy",
    });
    expect(store.write).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("cleans in the thread when the runtime has no cleaner", async () => {
    const { service } = fixture();
    await expect(service.upload("owner", "site", "logo", svgBytes())).resolves.toMatchObject({
      contentType: "image/svg+xml",
    });
  });
});

describe("site asset compression", () => {
  const webpBytes = () =>
    Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]);

  test.each([
    ["logo", "logo"],
    ["ogImage", "og_image"],
  ] as const)("compresses a %s with the %s profile", async (kind, profile) => {
    const compress = vi.fn(async () => ({ bytes: webpBytes(), contentType: "image/webp" as const }));
    const { service, entries } = fixture({ compressor: { compress } });

    const result = await service.upload("owner", "site", kind, png(64));

    expect(compress).toHaveBeenCalledWith(expect.objectContaining({ profile }));
    expect(result).toMatchObject({ contentType: "image/webp", size: webpBytes().byteLength });
    expect([...entries.values()][0]).toMatchObject({ contentType: "image/webp" });
  });

  test("never compresses a favicon", async () => {
    const compress = vi.fn(async () => null);
    const { service } = fixture({ compressor: { compress } });

    await service.upload("owner", "site", "favicon", png(64));

    expect(compress).not.toHaveBeenCalled();
  });
});

describe("site assets service", () => {
  test("rejects uploads from a non-owner before storage access", async () => {
    const { service, store } = fixture();
    await expect(
      service.upload("other", "site", "logo", png(24)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(store.write).not.toHaveBeenCalled();
  });
  test("deduplicates sanitized bytes", async () => {
    const { service, store, entries } = fixture();
    const first = await service.upload(
      "owner",
      "site",
      "logo",
      encode(svg("<script>alert(1)</script>")),
    );
    const second = await service.upload(
      "owner",
      "site",
      "logo",
      encode(svg("")),
    );
    expect(first.ref).toBe(second.ref);
    expect(siteAssetUploadResponseSchema.safeParse(first).success).toBe(true);
    expect(first.warnings?.[0].code).toBe("asset_sanitized");
    expect(store.write).toHaveBeenCalledTimes(1);
    expect([...entries.values()][0].contentType).toBe("image/svg+xml");
  });
  test("previews only assets of the resolved project", async () => {
    const { service } = fixture();
    const { ref } = await service.upload("owner", "site-a", "logo", png(24));
    await expect(
      service.preview("owner", "site-b", ref.slice(6)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.preview("other", "site-a", ref.slice(6)),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  test("sets private preview headers", async () => {
    const { service } = fixture();
    const { ref } = await service.upload(
      "owner",
      "site",
      "logo",
      encode(svg("")),
    );
    const response = await service.preview("owner", "site", ref.slice(6));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
  });
});
