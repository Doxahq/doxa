/**
 * ARTIFACT COMPATIBILITY GATE (read side)
 *
 * The renderer is evergreen: one build serves every published site. This
 * suite feeds every frozen artifact set through the runtime and compares the
 * route data with the committed golden files. A diff here means the current
 * reader changed what an already-published site renders.
 *
 * Do not update a golden to make this suite pass. Fix the reader so that old
 * artifacts render as before, or get explicit approval for the behavior
 * change, then regenerate with `vitest run -u` and review every diff.
 *
 * See `docs/current/docs-artifact-compatibility.md`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  createDefaultSiteConfig,
  resolveSiteConfig,
  siteConfigSchema,
} from "@doxahq/site-config";
import { serveSiteAsset, handleSiteAssetRequest } from "../src/site-assets";
import { SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS } from "@doxahq/docs-engine";
import {
  listFrozenArtifactSets,
  loadFrozenArtifactSetByName,
  type FrozenArtifactSet,
} from "@doxahq/docs-artifact-fixtures";
import {
  resetRuntimeSourceCachesForTests,
  runResolvedRuntimeRequest,
  type RuntimeRequest,
  type RuntimeSourceEnv,
} from "../src/runtime-source";
import { createTreeBucket, treeBucketOf } from "./support/tree-bucket";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const PUBLIC_BASE_URL = "https://frozen.doxa.page";

beforeEach(() => {
  resetRuntimeSourceCachesForTests();
});

afterEach(() => {
  resetRuntimeSourceCachesForTests();
  vi.restoreAllMocks();
});

describe.each(listFrozenArtifactSets())(
  "frozen set $name (schema v$schemaVersion)",
  (set) => {
    const env = createEnv(set);

    test("serves the pinned manifest", async () => {
      const result = await run(env, set, "getRoutes", {
        sectionSlug: "default",
      });

      expect(result).toMatchObject({ ok: true });
    });

    test.each(set.manifest.pages.map((page) => [page.href]))(
      "route data for %s matches the golden file",
      async (href) => {
        const result = await run(env, set, "getRouteData", { pathname: href });

        expect(result.ok, JSON.stringify(result)).toBe(true);
        // Approved additive contract: freeze all old fields unchanged, and
        // assert the new internal field independently rather than discarding it.
        if (!result.ok) throw new Error("Expected successful route data");
        const { siteConfig, ...legacyData } = z
          .object({
            siteConfig: siteConfigSchema,
          })
          .passthrough()
          .parse(result.data);
        const resolved = await run(env, set, "getResolvedSiteConfig");
        expect(resolved).toEqual({ ok: true, data: siteConfig });
        await expect(
          toGolden({ ok: true, data: legacyData }),
        ).toMatchFileSnapshot(set.expectedRouteDataPath(href));
      },
    );

    test("sections match the golden file", async () => {
      const result = await run(env, set, "getSections");

      expect(result.ok).toBe(true);
      await expect(toGolden(result)).toMatchFileSnapshot(
        set.expectedPath("sections.json"),
      );
    });

    test("navigation for every section matches the golden file", async () => {
      const sections = await run(env, set, "getSections");
      expect(sections.ok).toBe(true);
      const slugs = (sections.ok ? sections.data : []) as Array<{
        slug: string;
      }>;

      for (const { slug } of slugs) {
        const result = await run(env, set, "getNavigation", {
          sectionSlug: slug,
        });

        expect(result.ok, slug).toBe(true);
        await expect(toGolden(result)).toMatchFileSnapshot(
          set.expectedPath("navigation", `${slug}.json`),
        );
      }
    });

    test("feature config matches the golden file", async () => {
      const result = await run(env, set, "getFeatureConfig");

      expect(result.ok).toBe(true);
      await expect(toGolden(result)).toMatchFileSnapshot(
        set.expectedPath("features.json"),
      );
    });

    test("resolved site config matches its separate golden file", async () => {
      const result = await run(env, set, "getResolvedSiteConfig");
      expect(result.ok).toBe(true);
      await expect(toGolden(result)).toMatchFileSnapshot(
        set.expectedPath("site-config.json"),
      );
    });

    test("both search artifacts are readable", async () => {
      const [index, compiled] = await Promise.all([
        run(env, set, "getSearchIndex"),
        run(env, set, "getCompiledSearchIndex"),
      ]);

      expect(index).toMatchObject({ ok: true });
      expect(compiled).toMatchObject({ ok: true });
      expect(typeof (index.ok ? index.data : null)).toBe("string");
      expect(typeof (compiled.ok ? compiled.data : null)).toBe("string");
    });

    test("the pre-render plan matches the golden file and covers every page", async () => {
      const result = await run(env, set, "getPrerenderPlan");

      expect(result.ok).toBe(true);
      await expect(toGolden(result)).toMatchFileSnapshot(
        set.expectedPath("prerender-plan.json"),
      );

      const plan = (result.ok ? result.data : []) as PrerenderPlanEntry[];
      for (const page of set.manifest.pages) {
        expect(plan).toContainEqual({ kind: "page", pathname: page.href });
      }
    });
  },
);

describe("manifests from a newer writer", () => {
  const base = listFrozenArtifactSets()[0]!;
  const newerVersion = Math.max(...SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS) + 1;

  test("fail with a distinct error instead of a missing version", async () => {
    const env = createEnv(base, {
      [base.manifestPath]: JSON.stringify({
        ...base.manifest,
        schemaVersion: newerVersion,
      }),
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await run(env, base, "getRouteData", { pathname: "/" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unsupported_artifact_schema",
        message: expect.stringContaining(`schema version ${newerVersion}`),
      },
    });
    expect(result.ok ? "" : result.error.message).toContain(
      SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS.join(", "),
    );
    expect(consoleError).toHaveBeenCalledOnce();
    expect(JSON.parse(consoleError.mock.calls[0]![0] as string)).toMatchObject({
      event: "docs_artifact_schema_unsupported",
      manifestPath: base.manifestPath,
      schemaVersion: newerVersion,
    });
  });

  test("do not affect an invalid manifest, which stays a missing version", async () => {
    const env = createEnv(base, { [base.manifestPath]: "{}" });

    const result = await run(env, base, "getRouteData", { pathname: "/" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "version_not_found" },
    });
  });

  test("report an unsupported version when the newer payload shape differs", async () => {
    const env = createEnv(base, {
      [base.manifestPath]: JSON.stringify({
        schemaVersion: newerVersion,
        routes: [],
      }),
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await run(env, base, "getRouteData", { pathname: "/" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_artifact_schema" },
    });
    expect(consoleError).toHaveBeenCalledOnce();
    expect(JSON.parse(consoleError.mock.calls[0]![0] as string)).toMatchObject({
      event: "docs_artifact_schema_unsupported",
      schemaVersion: newerVersion,
    });
  });
});

describe("v2 config delivery", () => {
  const set = loadFrozenArtifactSetByName(2, "customized");
  const hash = "a".repeat(64);
  const assetPath = `sites/${set.siteId}/assets/${hash}`;

  test("rejects an unpublished asset without reading its object", async () => {
    const env = createEnv(set);
    const read = vi.spyOn(env.DOCS_BUCKET, "get");
    expect(
      (await serveSiteAsset(env, set.resolution, "c".repeat(64))).status,
    ).toBe(404);
    expect(read.mock.calls.some(([key]) => key.includes("/assets/"))).toBe(
      false,
    );
  });

  test("does not serve a referenced hash from another site", async () => {
    const foreignPath = `sites/another-site/assets/${hash}`;
    const env = createEnv(
      set,
      { [foreignPath]: "image" },
      { [foreignPath]: "image/png" },
    );
    expect((await serveSiteAsset(env, set.resolution, hash)).status).toBe(404);
  });

  test("serves a published SVG with sandboxed immutable headers", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    const env = createEnv(
      set,
      { [assetPath]: svg },
      { [assetPath]: "image/svg+xml" },
    );
    const response = await serveSiteAsset(env, set.resolution, hash);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(svg);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });

  test("never publicly caches an authenticated asset", async () => {
    const env = createEnv(
      set,
      { [assetPath]: "image" },
      { [assetPath]: "image/png" },
    );
    const response = await serveSiteAsset(
      env,
      { ...set.resolution, accessPolicy: "authenticated" },
      hash,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("requires a bearer token on the private HTTP asset endpoint", async () => {
    const response = await handleSiteAssetRequest(
      new Request(`https://runtime.internal/runtime-source/assets/${hash}`),
      createEnv(set),
    );
    expect(response?.status).toBe(401);
  });

  test("uses defaults when one stored config byte changes", async () => {
    const path = `${set.artifactPrefix}/settings/site.json`;
    const env = createEnv(set, { [path]: `${set.objects[path]} ` });
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await run(env, set, "getResolvedSiteConfig")).toEqual({
      ok: true,
      data: resolveSiteConfig(
        createDefaultSiteConfig({ projectName: set.projectSlug }),
      ),
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"site_config_integrity_mismatch"'),
    );
  });

  test("shares one config read across route data and legacy operations", async () => {
    const env = createEnv(set);
    // Storage reads the settings through their content-addressed blob.
    const siteConfigBlob = await treeBucketOf(env.DOCS_BUCKET).blobKeyOf(
      `${set.artifactPrefix}/settings/site.json`,
    );
    const read = vi.spyOn(env.DOCS_BUCKET, "get");
    await Promise.all([
      run(env, set, "getRouteData", { pathname: set.manifest.pages[0]!.href }),
      run(env, set, "getSiteConfig"),
      run(env, set, "getFeatureConfig"),
    ]);
    expect(
      read.mock.calls.filter(([key]) => key === siteConfigBlob),
    ).toHaveLength(1);
  });

  test("retains the 256 most recently used config prefixes", async () => {
    const env = createEnv(set);
    const get = env.DOCS_BUCKET.get.bind(env.DOCS_BUCKET);
    const siteConfig = await (await get(
      await treeBucketOf(env.DOCS_BUCKET).blobKeyOf(
        `${set.artifactPrefix}/settings/site.json`,
      ),
    ))!.text();
    // Each fake version has its own tree. Its entries use one marker hash per
    // version, so the blob reads of each version can be counted. The blobs
    // hold the published settings and a manifest with that version id.
    const marker = (kind: 1 | 2, index: number) =>
      `${kind}${index.toString(16).padStart(63, "0")}`;
    const siteConfigBlob = (index: number) =>
      `sites/${set.siteId}/blobs/${marker(2, index)}`;
    const manifestFor = (index: number) =>
      JSON.stringify({ ...set.manifest, versionId: `cache-${index}` });
    const read = vi
      .spyOn(env.DOCS_BUCKET, "get")
      .mockImplementation(async (key) => {
        const tree = /\/versions\/cache-(\d+)\/tree\.json$/.exec(key);
        if (tree) {
          const index = Number(tree[1]);
          return textObject(
            JSON.stringify({
              format: "doxa-version-tree",
              formatVersion: 1,
              siteId: set.siteId,
              versionId: `cache-${index}`,
              files: {
                "manifest.json": {
                  sha256: marker(1, index),
                  size: manifestFor(index).length,
                  contentType: "application/json; charset=utf-8",
                },
                "settings/site.json": {
                  sha256: marker(2, index),
                  size: siteConfig.length,
                  contentType: "application/json; charset=utf-8",
                },
              },
            }),
          );
        }
        const blob = /\/blobs\/([12])([0-9a-f]{63})$/.exec(key);
        if (blob) {
          const index = Number.parseInt(blob[2]!, 16);
          return textObject(blob[1] === "1" ? manifestFor(index) : siteConfig);
        }
        return get(key);
      });
    function textObject(text: string) {
      return {
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      } as unknown as R2ObjectBody;
    }
    function readVersion(index: number) {
      const prefix = `sites/${set.siteId}/versions/cache-${index}`;
      return runResolvedRuntimeRequest(env, {
        operation: "getResolvedSiteConfig",
        resolution: {
          ...set.resolution,
          publishedVersionId: `cache-${index}`,
          artifactPrefix: prefix,
          manifestPath: `${prefix}/manifest.json`,
        },
      });
    }
    for (let index = 0; index < 256; index++)
      expect((await readVersion(index)).ok).toBe(true);
    await readVersion(0);
    await readVersion(256);
    await readVersion(0);
    await readVersion(1);
    const count = (index: number) =>
      read.mock.calls.filter(([path]) => path === siteConfigBlob(index)).length;
    expect(count(0)).toBe(1);
    expect(count(1)).toBe(2);
    expect(count(256)).toBe(1);
  });
});

type RuntimeResult = Awaited<ReturnType<typeof runResolvedRuntimeRequest>>;

interface PrerenderPlanEntry {
  kind: string;
  pathname: string;
}

function run(
  env: RuntimeSourceEnv,
  set: FrozenArtifactSet,
  operation: RuntimeRequest["operation"],
  payload?: unknown,
): Promise<RuntimeResult> {
  return runResolvedRuntimeRequest(env, {
    resolution: set.resolution,
    operation,
    payload,
  });
}

function createEnv(
  set: FrozenArtifactSet,
  overrides: Record<string, string> = {},
  contentTypes: Record<string, string> = {},
): RuntimeSourceEnv {
  const objects: Record<string, string> = { ...set.objects, ...overrides };
  // Artifacts are stored as a version tree with content-addressed blobs, as
  // publication stores them. The frozen files and goldens do not change.
  return {
    DOCS_BUCKET: createTreeBucket(objects, contentTypes).bucket,
    DOCS_CONTENT_TOKEN: "test-runtime-token",
    DOCS_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
  };
}

/** Stable, reviewable JSON so golden diffs show real changes only. */
function toGolden(result: RuntimeResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
