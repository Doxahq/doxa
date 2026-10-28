import { describe, expect, test, vi } from "vitest";

import {
  createBucketCodeReader,
  loadRendererCodePackage,
  parseRendererCodePackage,
  type RendererCodeBytes,
  type RendererCodeReader,
} from "../src/renderer-code-package";

describe("parseRendererCodePackage", () => {
  test("accepts an immutable renderer module package", () => {
    const code = parseRendererCodePackage(
      JSON.stringify({
        schemaVersion: 1,
        buildId: "build-1",
        compatibilityDate: "2026-06-12",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "index.js",
        modules: {
          "index.js": "export default { fetch() {} }",
          "assets/chunk.js": "export const value = 1;",
        },
      }),
      "build-1",
    );

    expect(code.mainModule).toBe("index.js");
    expect(code.modules).toHaveProperty("assets/chunk.js");
  });

  test("rejects a package whose build ID does not match the deployment", () => {
    expect(() =>
      parseRendererCodePackage(
        JSON.stringify({
          schemaVersion: 1,
          buildId: "other-build",
          compatibilityDate: "2026-06-12",
          compatibilityFlags: [],
          mainModule: "index.js",
          modules: { "index.js": "export default {}" },
        }),
        "build-1",
      ),
    ).toThrow("build ID");
  });

  test("rejects packages with a missing main module", () => {
    expect(() =>
      parseRendererCodePackage(
        JSON.stringify({
          schemaVersion: 1,
          buildId: "build-1",
          compatibilityDate: "2026-06-12",
          compatibilityFlags: [],
          mainModule: "index.js",
          modules: { "other.js": "export default {}" },
        }),
        "build-1",
      ),
    ).toThrow("main module");
  });
});

function packageJson(buildId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    buildId,
    compatibilityDate: "2026-06-12",
    compatibilityFlags: [],
    mainModule: "index.js",
    modules: { "index.js": "export default {}" },
  });
}

function gzipStream(text: string): ReadableStream {
  return new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
}

function reader(
  source: RendererCodeBytes["source"],
  text: string,
): RendererCodeReader & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ body: gzipStream(text), source }));
}

let keyCounter = 0;
function uniqueKey(): string {
  keyCounter += 1;
  return `renderer-code/test-${keyCounter}.json.gz`;
}

describe("loadRendererCodePackage", () => {
  test("reports the first reader's source, then memory for the same isolate", async () => {
    const objectKey = uniqueKey();
    const cache = reader("cache", packageJson("build-1"));
    const bucket = reader("r2", packageJson("build-1"));
    const input = {
      objectKey,
      expectedBuildId: "build-1",
      readers: [cache, bucket],
    };

    const first = await loadRendererCodePackage(input);
    const second = await loadRendererCodePackage(input);

    expect(first.source).toBe("cache");
    expect(first.code.buildId).toBe("build-1");
    expect(second.source).toBe("memory");
    expect(second.code).toBe(first.code);
    expect(cache).toHaveBeenCalledTimes(1);
    expect(bucket).not.toHaveBeenCalled();
  });

  test("falls back to the next reader when a copy has another build ID", async () => {
    const warn = vi.fn();
    const loaded = await loadRendererCodePackage({
      objectKey: uniqueKey(),
      expectedBuildId: "build-1",
      readers: [
        reader("cache", packageJson("other-build")),
        reader("r2", packageJson("build-1")),
      ],
      warn,
    });

    expect(loaded.source).toBe("r2");
    expect(loaded.code.buildId).toBe("build-1");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("build ID"));
  });

  test("falls back to the next reader when the first one throws", async () => {
    const loaded = await loadRendererCodePackage({
      objectKey: uniqueKey(),
      expectedBuildId: "build-1",
      readers: [
        vi.fn(async () => {
          throw new Error("cache unavailable");
        }),
        reader("r2", packageJson("build-1")),
      ],
    });

    expect(loaded.source).toBe("r2");
  });

  test("throws the last error when every reader fails, and retries next time", async () => {
    const objectKey = uniqueKey();
    await expect(
      loadRendererCodePackage({
        objectKey,
        expectedBuildId: "build-1",
        readers: [reader("r2", packageJson("other-build"))],
      }),
    ).rejects.toThrow("build ID");

    const retried = await loadRendererCodePackage({
      objectKey,
      expectedBuildId: "build-1",
      readers: [reader("r2", packageJson("build-1"))],
    });
    expect(retried.source).toBe("r2");
  });

  test("the bucket reader reads only the configured key", async () => {
    const get = vi.fn(async () => ({ body: gzipStream(packageJson("build-1")) }));
    const bucket = { get } as unknown as R2Bucket;

    const bytes = await createBucketCodeReader(bucket, "renderer-code/a.json.gz")();

    expect(get).toHaveBeenCalledWith("renderer-code/a.json.gz");
    expect(bytes.source).toBe("r2");
  });

  test("the bucket reader fails when the object is missing", async () => {
    const bucket = { get: vi.fn(async () => null) } as unknown as R2Bucket;
    await expect(
      createBucketCodeReader(bucket, "renderer-code/a.json.gz")(),
    ).rejects.toThrow("not found");
  });
});
