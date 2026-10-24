import { describe, expect, test, vi } from "vitest";

import {
  createPrerenderManifestKey,
  createPrerenderObjectKey,
  parsePrerenderManifestV1,
  type PrerenderManifestV1,
} from "@doxahq/contracts/docs-prerender";

import { readPrerenderedRoute } from "../src/prerender-storage";
import { createServerTiming } from "../src/server-timing";

describe("pre-render storage", () => {
  test("reads a complete manifest and verifies content-addressed HTML and data", async () => {
    const html = new TextEncoder().encode("<!doctype html><p>Guide</p>");
    const data = new TextEncoder().encode(
      '{"type":"redirect","href":"/guide","status":308}',
    );
    const htmlDigest = await digest(html);
    const dataDigest = await digest(data);
    const manifest = createManifest(
      htmlDigest,
      html.byteLength,
      dataDigest,
      data.byteLength,
    );
    const bucket = createBucket(
      new Map([
        [
          createPrerenderManifestKey(siteId, renderId),
          encode(JSON.stringify(manifest)),
        ],
        [createPrerenderObjectKey(siteId, renderId, htmlDigest, "html"), html],
        [createPrerenderObjectKey(siteId, renderId, dataDigest, "json"), data],
      ]),
    );

    await expect(
      readPrerenderedRoute({
        bucket,
        expected: manifest.identity,
        pathname: "/guide",
        representation: "html",
      }),
    ).resolves.toMatchObject({ status: "hit", html });
    await expect(
      readPrerenderedRoute({
        bucket,
        expected: manifest.identity,
        pathname: "/guide",
        representation: "data",
      }),
    ).resolves.toMatchObject({ status: "hit", data });
  });

  test("reads only the requested representation", async () => {
    const html = encode("<!doctype html><p>Guide</p>");
    const data = encode('{"type":"page"}');
    const htmlDigest = await digest(html);
    const dataDigest = await digest(data);
    const manifest = createManifest(
      htmlDigest,
      html.byteLength,
      dataDigest,
      data.byteLength,
    );
    const dataKey = createPrerenderObjectKey(
      siteId,
      renderId,
      dataDigest,
      "json",
    );
    const bucket = createBucket(
      new Map([
        [
          createPrerenderManifestKey(siteId, renderId),
          encode(JSON.stringify(manifest)),
        ],
        [createPrerenderObjectKey(siteId, renderId, htmlDigest, "html"), html],
        [dataKey, data],
      ]),
    );

    const lookup = await readPrerenderedRoute({
      bucket,
      expected: manifest.identity,
      pathname: "/guide",
      representation: "html",
    });

    expect(lookup).toMatchObject({ status: "hit", html });
    expect(lookup).not.toHaveProperty("data");
    expect(bucket.get).not.toHaveBeenCalledWith(dataKey);
  });

  test("serves a saved redirect from the manifest entry alone", async () => {
    const manifest = createManifest("a".repeat(64), 1, "b".repeat(64), 1);
    manifest.routes = [
      {
        kind: "redirect",
        pathname: "/old",
        target: "/guide",
        status: 308,
        data: {
          digest: "b".repeat(64),
          byteLength: 1,
          contentType: "application/json; charset=utf-8",
          objectName: `objects/${"b".repeat(64)}.json`,
        },
      },
    ];
    const bucket = createBucket(
      new Map([
        [
          createPrerenderManifestKey(siteId, renderId),
          encode(JSON.stringify(manifest)),
        ],
      ]),
    );

    await expect(
      readPrerenderedRoute({
        bucket,
        expected: manifest.identity,
        pathname: "/old",
        representation: "html",
      }),
    ).resolves.toEqual({
      status: "hit",
      redirect: { href: "/guide", status: 308 },
      routeKind: "redirect",
    });
    expect(bucket.get).toHaveBeenCalledOnce();
  });

  test("records each saved-output read when debug timing is enabled", async () => {
    const html = encode("<!doctype html><p>Guide</p>");
    const data = encode(
      '{"type":"redirect","href":"/guide","status":308}',
    );
    const htmlDigest = await digest(html);
    const dataDigest = await digest(data);
    const manifest = createManifest(
      htmlDigest,
      html.byteLength,
      dataDigest,
      data.byteLength,
    );
    const timing = createServerTiming("true");

    await readPrerenderedRoute({
      bucket: createBucket(
        new Map([
          [
            createPrerenderManifestKey(siteId, renderId),
            encode(JSON.stringify(manifest)),
          ],
          [
            createPrerenderObjectKey(siteId, renderId, htmlDigest, "html"),
            html,
          ],
          [
            createPrerenderObjectKey(siteId, renderId, dataDigest, "json"),
            data,
          ],
        ]),
      ),
      expected: manifest.identity,
      pathname: "/guide",
      representation: "html",
      timing,
    });

    expect(timing.entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "doxa_prerender_manifest_get",
          description: "HIT",
        }),
        expect.objectContaining({ name: "doxa_prerender_manifest_read" }),
        expect.objectContaining({ name: "doxa_prerender_manifest_parse" }),
        expect.objectContaining({
          name: "doxa_prerender_html_get",
          description: "HIT",
        }),
        expect.objectContaining({ name: "doxa_prerender_html_read" }),
        expect.objectContaining({ name: "doxa_prerender_html_hash" }),
        expect.objectContaining({
          name: "doxa_prerender_lookup",
          description: "hit",
        }),
      ]),
    );
  });

  test("identifies the active storage step when the lookup deadline expires", async () => {
    const manifest = createManifest("a".repeat(64), 1, "b".repeat(64), 1);
    const timing = createServerTiming("true");

    const result = await readPrerenderedRoute({
      bucket: {
        get: async () => new Promise<null>(() => undefined),
      },
      deadlineMs: 5,
      expected: manifest.identity,
      pathname: "/guide",
      representation: "html",
      timing,
    });

    expect(result).toEqual({ status: "unavailable", reason: "deadline" });
    expect(timing.entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "doxa_prerender_manifest_get",
          description: "ERROR",
        }),
        expect.objectContaining({
          name: "doxa_prerender_lookup",
          description: "unavailable:deadline",
        }),
      ]),
    );
  });

  test.each(["missing", "truncated", "corrupt", "oversized"] as const)(
    "returns an invalid or missing result for a %s object",
    async (failure) => {
      const html = new TextEncoder().encode("<!doctype html><p>Guide</p>");
      const data = new TextEncoder().encode(
        '{"type":"redirect","href":"/guide","status":308}',
      );
      const htmlDigest = await digest(html);
      const dataDigest = await digest(data);
      const manifest = createManifest(
        htmlDigest,
        html.byteLength,
        dataDigest,
        data.byteLength,
      );
      const objects = new Map<string, Uint8Array>([
        [
          createPrerenderManifestKey(siteId, renderId),
          encode(JSON.stringify(manifest)),
        ],
        [createPrerenderObjectKey(siteId, renderId, htmlDigest, "html"), html],
        [createPrerenderObjectKey(siteId, renderId, dataDigest, "json"), data],
      ]);
      const htmlKey = createPrerenderObjectKey(
        siteId,
        renderId,
        htmlDigest,
        "html",
      );
      if (failure === "missing") objects.delete(htmlKey);
      if (failure === "truncated") objects.set(htmlKey, html.slice(0, 5));
      if (failure === "corrupt")
        objects.set(htmlKey, encode("different bytes but same length"));
      if (failure === "oversized")
        objects.set(htmlKey, new Uint8Array(2 * 1024 * 1024 + 1));

      const result = await readPrerenderedRoute({
        bucket: createBucket(objects),
        expected: manifest.identity,
        pathname: "/guide",
        representation: "html",
      });

      expect(result.status).toBe(failure === "missing" ? "invalid" : "invalid");
    },
  );

  test("does not read objects for an unknown route in a valid plan", async () => {
    const html = encode("ok");
    const data = encode("{}");
    const htmlDigest = await digest(html);
    const dataDigest = await digest(data);
    const manifest = createManifest(
      htmlDigest,
      html.length,
      dataDigest,
      data.length,
    );
    const bucket = createBucket(
      new Map([
        [
          createPrerenderManifestKey(siteId, renderId),
          encode(JSON.stringify(manifest)),
        ],
      ]),
    );

    await expect(
      readPrerenderedRoute({
        bucket,
        expected: manifest.identity,
        pathname: "/unknown",
        representation: "html",
      }),
    ).resolves.toEqual({ status: "miss", reason: "unknown_route" });
    expect(bucket.get).toHaveBeenCalledOnce();
  });

  test("rejects duplicate, unsorted, or prototype-sensitive manifest routes", () => {
    const manifest = createManifest("a".repeat(64), 1, "b".repeat(64), 1);
    manifest.routes.push({ ...manifest.routes[0]! });
    expect(() => parsePrerenderManifestV1(manifest)).toThrow();

    const unsafe = JSON.parse(
      JSON.stringify(createManifest("a".repeat(64), 1, "b".repeat(64), 1)),
    );
    unsafe.routes[0].pathname = "/__proto__";
    expect(() => parsePrerenderManifestV1(unsafe)).toThrow();
  });
});

const siteId = "site-1";
const renderId = "1".repeat(64);

function createManifest(
  htmlDigest: string,
  htmlBytes: number,
  dataDigest: string,
  dataBytes: number,
): PrerenderManifestV1 {
  return {
    schemaVersion: 1,
    identity: {
      siteId,
      renderId,
      artifactIdentity: "2".repeat(64),
      rendererReleaseId: "3".repeat(64),
      renderContextId: "4".repeat(64),
      artifactPrefix: "sites/site-1/versions/source-1",
      sourceManifestPath: "sites/site-1/versions/source-1/manifest.json",
      sourceArtifactVersion: "source-1",
      trustedRequestOrigin: "https://docs.example.com",
    },
    completedAt: "2026-09-19T20:00:00.000Z",
    routes: [
      {
        kind: "page",
        pathname: "/guide",
        html: {
          digest: htmlDigest,
          byteLength: htmlBytes,
          contentType: "text/html; charset=utf-8",
          objectName: `objects/${htmlDigest}.html`,
        },
        data: {
          digest: dataDigest,
          byteLength: dataBytes,
          contentType: "application/json; charset=utf-8",
          objectName: `objects/${dataDigest}.json`,
        },
      },
    ],
  };
}

function createBucket(objects: Map<string, Uint8Array>) {
  return {
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.slice().buffer,
      };
    }),
  };
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function digest(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const result = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
