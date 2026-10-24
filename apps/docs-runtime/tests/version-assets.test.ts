import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadFrozenArtifactSetByName } from "@doxahq/docs-artifact-fixtures";
import { sha256Hex } from "@doxahq/docs-engine";
import { readPageAssetVersions } from "../src/page-assets";
import {
  resetRuntimeSourceCachesForTests,
  runResolvedRuntimeRequest,
  type RuntimeSourceEnv,
} from "../src/runtime-source";
import {
  handleVersionAssetRequest,
  serveVersionAsset,
} from "../src/version-assets";
import { createTreeBucket } from "./support/tree-bucket";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const set = loadFrozenArtifactSetByName(2, "starter");
const PNG_PATH = `${set.artifactPrefix}/assets/diagram.png`;
const SVG_PATH = `${set.artifactPrefix}/assets/flow.svg`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

beforeEach(() => resetRuntimeSourceCachesForTests());
afterEach(() => resetRuntimeSourceCachesForTests());

function createEnv(extra: Record<string, string> = {}): RuntimeSourceEnv {
  return {
    DOCS_BUCKET: createTreeBucket({
      ...set.objects,
      [PNG_PATH]: "png-bytes",
      [SVG_PATH]: SVG,
      ...extra,
    }).bucket,
    DOCS_CONTENT_TOKEN: "test-runtime-token",
    DOCS_PUBLIC_BASE_URL: "https://frozen.doxa.page",
  };
}

describe("version assets", () => {
  test("serves an image of the pinned version from its tree", async () => {
    const response = await serveVersionAsset(
      createEnv(),
      set.resolution,
      "diagram.png",
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png-bytes");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("sandboxes an SVG image", async () => {
    const response = await serveVersionAsset(
      createEnv(),
      set.resolution,
      "flow.svg",
    );

    expect(await response.text()).toBe(SVG);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });

  test("never publicly caches an image of a private site", async () => {
    const response = await serveVersionAsset(
      createEnv(),
      { ...set.resolution, accessPolicy: "authenticated" },
      "diagram.png",
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("answers 404 for an image that the version does not hold", async () => {
    expect(
      (await serveVersionAsset(createEnv(), set.resolution, "missing.png"))
        .status,
    ).toBe(404);
  });

  test.each([
    "../manifest.json",
    "diagram.PNG",
    "diagram.png/../../manifest.json",
    "notes.txt",
    "manifest.json",
    "",
  ])("refuses the name %j without a read", async (name) => {
    const env = createEnv();
    const read = vi.spyOn(env.DOCS_BUCKET, "get");

    expect((await serveVersionAsset(env, set.resolution, name)).status).toBe(
      404,
    );
    expect(read).not.toHaveBeenCalled();
  });

  test("never reads a folder of another site", async () => {
    const env = createEnv();
    const read = vi.spyOn(env.DOCS_BUCKET, "get");
    const response = await serveVersionAsset(
      env,
      { ...set.resolution, siteId: "another-site" },
      "diagram.png",
    );

    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  test("requires a bearer token on the private HTTP endpoint", async () => {
    const response = await handleVersionAssetRequest(
      new Request(
        "https://runtime.internal/runtime-source/version-assets/diagram.png",
      ),
      createEnv(),
    );

    expect(response?.status).toBe(401);
  });

  test("leaves other paths to the other handlers", async () => {
    expect(
      await handleVersionAssetRequest(
        new Request("https://runtime.internal/runtime-source/assets/x"),
        createEnv(),
      ),
    ).toBeNull();
  });
});

const pngSha = () => sha256Hex(new TextEncoder().encode("png-bytes"));

describe("immutable asset URLs", () => {
  test("a hash that matches the file makes the response immutable", async () => {
    const response = await serveVersionAsset(
      createEnv(),
      set.resolution,
      "diagram.png",
      await pngSha(),
    );

    expect(await response.text()).toBe("png-bytes");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("a hash of another file keeps the short cache", async () => {
    const response = await serveVersionAsset(
      createEnv(),
      set.resolution,
      "diagram.png",
      "b".repeat(64),
    );

    expect(await response.text()).toBe("png-bytes");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("a private site never caches publicly, even with a hash", async () => {
    const response = await serveVersionAsset(
      createEnv(),
      { ...set.resolution, accessPolicy: "authenticated" },
      "diagram.png",
      await pngSha(),
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("page asset hashes", () => {
  test("maps each linked asset of the version to its hash", async () => {
    const env = createEnv();
    expect(
      await readPageAssetVersions(
        env.DOCS_BUCKET,
        set.artifactPrefix,
        "![a](/assets/diagram.png) and ![b](/assets/missing.png).",
      ),
    ).toEqual({ "diagram.png": await pngSha() });
  });

  test("is undefined for a page without asset links", async () => {
    const env = createEnv();
    const read = vi.spyOn(env.DOCS_BUCKET, "get");
    expect(
      await readPageAssetVersions(env.DOCS_BUCKET, set.artifactPrefix, "# Hi"),
    ).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  test("is undefined when the prefix is not a version folder", async () => {
    expect(
      await readPageAssetVersions(
        createEnv().DOCS_BUCKET,
        "not-a-version",
        "![a](/assets/diagram.png)",
      ),
    ).toBeUndefined();
  });

  test("getPage sends the hashes with a page that links to assets", async () => {
    const sourcePath = `${set.artifactPrefix}/source/index.mdx`;
    const body = `${set.objects[sourcePath]}\n\n![Diagram](/assets/diagram.png)\n`;
    const result = await runResolvedRuntimeRequest(
      createEnv({ [sourcePath]: body }),
      { resolution: set.resolution, operation: "getPage", payload: { slug: "/" } },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { assets: { "diagram.png": await pngSha() } },
    });
  });

  test("getPage leaves the field out for a page without assets", async () => {
    const result = await runResolvedRuntimeRequest(createEnv(), {
      resolution: set.resolution,
      operation: "getPage",
      payload: { slug: "/" },
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.data).not.toHaveProperty("assets");
  });
});
