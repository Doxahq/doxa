import { describe, expect, test, vi } from "vitest";

import {
  createPrerenderManifestKey,
  createPrerenderObjectKey,
  type PrerenderManifestV1,
} from "@doxahq/contracts/docs-prerender";

import {
  commitPrerenderOutput,
  inspectPrerenderManifest,
  writePrerenderObject,
} from "../src/storage-writer";

describe("pre-render output writer", () => {
  test("writes verified content objects before committing the manifest", async () => {
    const html = encode("<!doctype html><p>Guide</p>");
    const data = encode('{"type":"redirect","href":"/guide","status":308}');
    const manifest = await createManifest(html, data);
    const bucket = createBucket();

    await expect(
      commitPrerenderOutput({ bucket, manifest, objects: [html, data] }),
    ).resolves.toEqual({ status: "committed" });

    const route = manifest.routes[0];
    if (route?.kind !== "page") throw new Error("Invalid page fixture");
    const writes = bucket.put.mock.calls.map(([key]) => key);
    expect(writes.at(-1)).toBe(createPrerenderManifestKey(siteId, renderId));
    expect(writes.slice(0, -1)).toEqual([
      createPrerenderObjectKey(siteId, renderId, route.html.digest, "html"),
      createPrerenderObjectKey(siteId, renderId, route.data.digest, "json"),
    ]);
    expect(bucket.put.mock.calls.at(-1)?.[2]).toEqual({
      onlyIf: { etagDoesNotMatch: "*" },
    });
  });

  test("does not overwrite an already complete manifest", async () => {
    const html = encode("html");
    const data = encode('{"type":"redirect","href":"/guide","status":308}');
    const manifest = await createManifest(html, data);
    const manifestBytes = encode(JSON.stringify(manifest));
    const bucket = createBucket(
      new Map([[createPrerenderManifestKey(siteId, renderId), manifestBytes]]),
    );

    await expect(
      commitPrerenderOutput({ bucket, manifest, objects: [html, data] }),
    ).resolves.toEqual({ status: "already_complete" });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test("uses the observed etag when repairing a corrupt manifest", async () => {
    const html = encode("html");
    const data = encode('{"type":"redirect","href":"/guide","status":308}');
    const manifest = await createManifest(html, data);
    const bucket = createBucket(
      new Map([
        [createPrerenderManifestKey(siteId, renderId), encode("not-json")],
      ]),
    );

    await commitPrerenderOutput({ bucket, manifest, objects: [html, data] });

    expect(bucket.put.mock.calls.at(-1)?.[2]).toEqual({
      onlyIf: { etagMatches: "etag-observed" },
    });
  });

  test("rejects bodies that do not match the manifest", async () => {
    const html = encode("html");
    const data = encode('{"type":"redirect","href":"/guide","status":308}');
    const manifest = await createManifest(html, data);

    await expect(
      commitPrerenderOutput({
        bucket: createBucket(),
        manifest,
        objects: [encode("wrong"), data],
      }),
    ).rejects.toThrow(/referenced object/i);
  });

  test("repairs a corrupt content-addressed object against its observed etag", async () => {
    const html = encode("expected html");
    const digestValue = await digest(html);
    const key = createPrerenderObjectKey(siteId, renderId, digestValue, "html");
    const bucket = createBucket(new Map([[key, encode("corrupt html")]]));

    await writePrerenderObject({
      bucket,
      identity: (await createManifest(html, encode("data"))).identity,
      bytes: html,
      extension: "html",
    });

    expect(bucket.put).toHaveBeenCalledWith(key, html, {
      onlyIf: { etagMatches: "etag-observed" },
    });
  });

  test("does not overwrite a corrupt object after losing the repair fence", async () => {
    const html = encode("expected html");
    const digestValue = await digest(html);
    const key = createPrerenderObjectKey(siteId, renderId, digestValue, "html");
    const bucket = createBucket(new Map([[key, encode("corrupt html")]]));
    bucket.put.mockResolvedValueOnce(null as never);

    await expect(
      writePrerenderObject({
        bucket,
        identity: (await createManifest(html, encode("data"))).identity,
        bytes: html,
        extension: "html",
      }),
    ).rejects.toThrow(/concurrent writer/i);
  });

  test("reports a complete manifest for the exact render identity", async () => {
    const manifest = await createManifest(encode("html"), encode("data"));
    const bucket = createBucket(
      new Map([
        [
          createPrerenderManifestKey(siteId, renderId),
          encode(JSON.stringify(manifest)),
        ],
      ]),
    );

    await expect(
      inspectPrerenderManifest({ bucket, identity: manifest.identity }),
    ).resolves.toEqual({ status: "complete" });
  });

  test("reports invalid output when the manifest belongs to another release", async () => {
    const manifest = await createManifest(encode("html"), encode("data"));
    const bucket = createBucket(
      new Map([
        [
          createPrerenderManifestKey(siteId, renderId),
          encode(JSON.stringify(manifest)),
        ],
      ]),
    );

    await expect(
      inspectPrerenderManifest({
        bucket,
        identity: {
          ...manifest.identity,
          rendererReleaseId: "9".repeat(64),
        },
      }),
    ).resolves.toEqual({ status: "invalid" });
  });
});

const siteId = "site-1";
const renderId = "1".repeat(64);

async function createManifest(
  html: Uint8Array,
  data: Uint8Array,
): Promise<PrerenderManifestV1> {
  const htmlDigest = await digest(html);
  const dataDigest = await digest(data);
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
          byteLength: html.byteLength,
          contentType: "text/html; charset=utf-8",
          objectName: `objects/${htmlDigest}.html`,
        },
        data: {
          digest: dataDigest,
          byteLength: data.byteLength,
          contentType: "application/json; charset=utf-8",
          objectName: `objects/${dataDigest}.json`,
        },
      },
    ],
  };
}

function createBucket(initial = new Map<string, Uint8Array>()) {
  const objects = new Map(initial);
  return {
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        etag: "etag-observed",
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.slice().buffer,
      };
    }),
    put: vi.fn(async (key: string, value: Uint8Array, _options?: unknown) => {
      objects.set(key, value);
      return { etag: "etag-new" };
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
