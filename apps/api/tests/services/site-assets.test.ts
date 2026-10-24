import { describe, expect, test, vi } from "vitest";
import { SITE_ASSET_MAX_BYTES, type SiteAssetKind } from "@doxahq/site-config";
import { siteAssetUploadResponseSchema } from "@doxahq/contracts/site-assets";
import { prepareSiteAsset } from "../../src/services/site-assets/content";
import { sanitizeSvg } from "../../src/services/site-assets/svg";
import { SiteAssetsService } from "../../src/services/site-assets/service";
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

function fixture() {
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
  };
  const sites = {
    getDocsSiteForUser: vi.fn(async (user: string, project: string) =>
      user === "owner" ? { siteId: project } : null,
    ),
  };
  return { store, entries, service: new SiteAssetsService(sites, store) };
}

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
