import { describe, expect, test } from "vitest";
import { versionTreeKey } from "@doxahq/docs-engine";
import { artifactReader, writeArtifactVersion } from "../src/artifact-storage";

const siteId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const prefix = `sites/${siteId}/versions/${versionId}`;

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const bucket = {
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes
        ? {
            size: bytes.byteLength,
            text: async () => new TextDecoder().decode(bytes),
            arrayBuffer: async () => bytes.slice().buffer,
          }
        : null;
    },
    async head(key: string) {
      return objects.has(key) ? {} : null;
    },
    async put(key: string, value: string | Uint8Array) {
      puts.push(key);
      objects.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects, puts };
}

const files = [
  { path: "manifest.json", content: "{}", contentType: "application/json" },
  { path: "source/index.mdx", content: "# Home", contentType: "text/plain" },
];

describe("generated artifact storage", () => {
  test("writes blobs first, the tree last, and checks the job before each file", async () => {
    const { bucket, puts } = memoryBucket();
    let checks = 0;

    const result = await writeArtifactVersion(bucket, {
      siteId,
      versionId,
      files,
      beforeEachFile: async () => {
        checks += 1;
      },
    });

    expect(result).toEqual({
      artifactPrefix: prefix,
      manifestPath: `${prefix}/manifest.json`,
    });
    expect(checks).toBe(2);
    expect(puts.at(-1)).toBe(versionTreeKey(prefix));
    expect(
      await (await artifactReader(bucket).get(`${prefix}/source/index.mdx`))?.text(),
    ).toBe("# Home");
  });

  test("a retried step writes the same tree again", async () => {
    const { bucket, objects } = memoryBucket();
    await writeArtifactVersion(bucket, { siteId, versionId, files });
    const firstTree = objects.get(versionTreeKey(prefix));

    await writeArtifactVersion(bucket, { siteId, versionId, files });

    expect(objects.get(versionTreeKey(prefix))).toEqual(firstTree);
  });

  test("stops before the tree when the job is no longer active", async () => {
    const { bucket, objects } = memoryBucket();

    await expect(
      writeArtifactVersion(bucket, {
        siteId,
        versionId,
        files,
        beforeEachFile: async () => {
          throw new Error("Generation job is no longer active.");
        },
      }),
    ).rejects.toThrow("no longer active");
    expect(objects.has(versionTreeKey(prefix))).toBe(false);
  });
});
