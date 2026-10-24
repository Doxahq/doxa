import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadFrozenArtifactSetByName } from "@doxahq/docs-artifact-fixtures";
import {
  resetRuntimeSourceCachesForTests,
  runResolvedRuntimeRequest,
  type RuntimeSourceEnv,
} from "../src/runtime-source";
import { createTreeBucket } from "./support/tree-bucket";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const set = loadFrozenArtifactSetByName(2, "starter");

beforeEach(() => resetRuntimeSourceCachesForTests());
afterEach(() => resetRuntimeSourceCachesForTests());

function env(bucket: R2Bucket): RuntimeSourceEnv {
  return {
    DOCS_BUCKET: bucket,
    DOCS_CONTENT_TOKEN: "test-runtime-token",
    DOCS_PUBLIC_BASE_URL: "https://frozen.doxa.page",
  };
}

function routes(bucket: R2Bucket) {
  return runResolvedRuntimeRequest(env(bucket), {
    resolution: set.resolution,
    operation: "getRoutes",
    payload: { sectionSlug: "default" },
  });
}

describe("artifact storage in the runtime", () => {
  test("reads a version from its tree", async () => {
    expect(await routes(createTreeBucket(set.objects).bucket)).toMatchObject({
      ok: true,
    });
  });

  test("treats a folder without a tree as a missing version", async () => {
    const empty = { get: async () => null } as unknown as R2Bucket;

    expect(await routes(empty)).toMatchObject({
      ok: false,
      error: { code: "version_not_found" },
    });
  });

  test("does not read an old flat folder", async () => {
    const flat = {
      get: async (key: string) => {
        const text = set.objects[key];
        return text === undefined
          ? null
          : {
              text: async () => text,
              arrayBuffer: async () => new TextEncoder().encode(text).buffer,
            };
      },
    } as unknown as R2Bucket;

    expect(await routes(flat)).toMatchObject({
      ok: false,
      error: { code: "version_not_found" },
    });
  });
});
