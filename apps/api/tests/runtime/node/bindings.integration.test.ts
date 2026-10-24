/**
 * Integration tests of the Node bindings against real servers. They run only
 * when the server URLs are set, for example:
 *
 *   # Valkey in cluster mode, as ElastiCache Serverless runs it: CROSSSLOT applies.
 *   docker run -d --rm --name doxa-valkey-test -p 6390:6379 valkey/valkey:8.1-alpine valkey-server --cluster-enabled yes
 *   docker exec doxa-valkey-test valkey-cli CLUSTER ADDSLOTSRANGE 0 16383
 *   docker exec doxa-valkey-test valkey-cli CLUSTER INFO   # wait for cluster_state:ok
 *   docker run -d --rm -p 9000:9000 -e MINIO_ROOT_USER=test -e MINIO_ROOT_PASSWORD=testtesttest minio/minio server /data
 *   VALKEY_TEST_URL=redis://localhost:6390 S3_TEST_ENDPOINT=http://localhost:9000 \
 *     S3_TEST_ACCESS_KEY_ID=test S3_TEST_SECRET_ACCESS_KEY=testtesttest pnpm exec vitest run tests/runtime
 */
import { randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3R2Bucket } from "../../../src/runtime/node/bindings/r2-s3-bucket";
import { ValkeyKvNamespace } from "../../../src/runtime/node/bindings/valkey-kv-namespace";

const valkeyUrl = process.env.VALKEY_TEST_URL;
const s3Endpoint = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!valkeyUrl)("ValkeyKvNamespace", () => {
  const namespace = `test-${randomUUID()}`;
  let valkey: Redis;
  let kv: ValkeyKvNamespace;

  beforeAll(() => {
    valkey = new Redis(valkeyUrl ?? "");
    kv = new ValkeyKvNamespace(valkey, namespace);
  });

  afterAll(async () => {
    await valkey.quit();
  });

  it("keeps every key of a namespace in one cluster slot", async () => {
    await kv.put("a", "1");
    await kv.put("b/c", "2", { metadata: { m: 1 } });
    await kv.delete("a");

    const keys = await valkey.keys(`*${namespace}*`);
    const slots = new Set(await Promise.all(keys.map((key) => valkey.cluster("KEYSLOT", key))));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(slots.size).toBe(1);
  });

  it("reads back text, JSON and bytes", async () => {
    await kv.put("text", "hello");
    await kv.put("json", JSON.stringify({ a: 1 }));
    await kv.put("bytes", new Uint8Array([1, 2, 3]));

    expect(await kv.get("text")).toBe("hello");
    expect(await kv.get("text", "text")).toBe("hello");
    expect(await kv.get("json", { type: "json" })).toEqual({ a: 1 });
    expect(new Uint8Array(await kv.get<ArrayBuffer>("bytes", "arrayBuffer"))).toEqual(new Uint8Array([1, 2, 3]));
    expect(await kv.get("missing")).toBeNull();
  });

  it("keeps metadata and expiry, and lists them", async () => {
    await kv.put("grant:user-1:a", "{}", { expirationTtl: 600, metadata: { scope: "read" } });

    const read = await kv.getWithMetadata("grant:user-1:a");
    expect(read).toEqual({ value: "{}", metadata: { scope: "read" }, cacheStatus: null });
    const ttl = await valkey.ttl(`kv:{${namespace}}:grant:user-1:a`);
    expect(ttl).toBeGreaterThan(590);

    const listed = await kv.list({ prefix: "grant:user-1:" });
    expect(listed.list_complete).toBe(true);
    expect(listed.keys).toEqual([{ name: "grant:user-1:a", expiration: expect.any(Number), metadata: { scope: "read" } }]);
  });

  it("pages a prefix in key order with a cursor, and skips expired keys", async () => {
    for (const name of ["page:c", "page:a", "page:e", "page:b", "page:d", "pagex:z"]) await kv.put(name, name);
    await kv.put("page:gone", "x", { expirationTtl: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const first = await kv.list({ prefix: "page:", limit: 2 });
    expect(first.keys.map((key) => key.name)).toEqual(["page:a", "page:b"]);
    expect(first.list_complete).toBe(false);
    const cursor = first.list_complete ? null : first.cursor;

    const rest = await kv.list({ prefix: "page:", cursor });
    expect(rest.keys.map((key) => key.name)).toEqual(["page:c", "page:d", "page:e"]);
    expect(rest.list_complete).toBe(true);
  });

  it("deletes a key and its index entry", async () => {
    await kv.put("delete-me", "x");
    await kv.delete("delete-me");

    expect(await kv.get("delete-me")).toBeNull();
    expect((await kv.list({ prefix: "delete-me" })).keys).toEqual([]);
  });
});

describe.skipIf(!s3Endpoint)("S3R2Bucket", () => {
  const bucketName = `doxa-test-${randomUUID().slice(0, 8)}`;
  let bucket: S3R2Bucket;

  beforeAll(async () => {
    const client = new S3Client({
      region: "auto",
      endpoint: s3Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "",
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucketName }));
    bucket = new S3R2Bucket(client, bucketName);
  });

  it("writes and reads an object with its metadata", async () => {
    await bucket.put("sites/s1/assets/a.png", new Uint8Array([137, 80, 78, 71]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { kind: "image" },
    });

    const object = await bucket.get("sites/s1/assets/a.png");
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    expect(object?.customMetadata).toEqual({ kind: "image" });
    expect(object?.size).toBe(4);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));

    const head = await bucket.head("sites/s1/assets/a.png");
    expect(head?.customMetadata).toEqual({ kind: "image" });
  });

  it("returns null for a missing object", async () => {
    expect(await bucket.get("missing")).toBeNull();
    expect(await bucket.head("missing")).toBeNull();
  });

  it("reads a body once, as R2 does", async () => {
    await bucket.put("once.txt", "text");
    const object = await bucket.get("once.txt");

    expect(await object!.text()).toBe("text");
    await expect(object!.text()).rejects.toThrow(/already read/);
  });

  it("lists a prefix in pages and deletes many keys", async () => {
    const keys = ["v/1/a.md", "v/1/b.md", "v/1/c.md"];
    for (const key of keys) await bucket.put(key, key);

    const first = await bucket.list({ prefix: "v/1/", limit: 2 });
    expect(first.objects.map((object) => object.key)).toEqual(["v/1/a.md", "v/1/b.md"]);
    expect(first.truncated).toBe(true);
    const second = await bucket.list({ prefix: "v/1/", cursor: first.truncated ? first.cursor : undefined });
    expect(second.objects.map((object) => object.key)).toEqual(["v/1/c.md"]);
    expect(second.objects[0]?.uploaded).toBeInstanceOf(Date);

    await bucket.delete(keys);
    expect((await bucket.list({ prefix: "v/1/" })).objects).toEqual([]);
  });

  it("refuses options that the adapter does not support", async () => {
    await expect(bucket.get("x", { range: { offset: 0, length: 1 } })).rejects.toThrow(/not supported/);
  });
});
