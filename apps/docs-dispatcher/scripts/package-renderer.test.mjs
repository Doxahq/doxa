import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";
import { createRendererReleaseId } from "@doxahq/contracts/docs-prerender";

import {
  createRendererPackage,
  parseRendererPackageArgs,
} from "./package-renderer.mjs";
import {
  listClientAssetFiles,
  planClientAssetUploads,
} from "../../../scripts/lib/client-assets-upload.mjs";

const gunzipAsync = promisify(gunzip);

describe("createRendererPackage", () => {
  test("reads the explicit DEBUG deployment variable", () => {
    expect(parseRendererPackageArgs([], { DEBUG: "true" })).toMatchObject({
      debug: "true",
    });
  });

  test("only enables production caching for the internal cache entrypoints", async () => {
    const fixture = await createFixture();
    const result = await createRendererPackage({
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist",
      dispatcherConfig: fileURLToPath(
        new URL("../wrangler.json", import.meta.url),
      ),
    });

    const config = JSON.parse(
      await readFile(result.generatedConfigPath, "utf8"),
    );
    expect(config.cache).toEqual({
      enabled: false,
      cross_version_cache: true,
    });
    expect(config.exports).toEqual({
      default: { type: "worker", cache: { enabled: false } },
      DocsHostCache: { type: "worker", cache: { enabled: true } },
      DocsHtmlCache: { type: "worker", cache: { enabled: true } },
      DocsPrerenderCache: { type: "worker", cache: { enabled: true } },
      DocsRouteDataCache: { type: "worker", cache: { enabled: true } },
      DocsRendererCodeCache: { type: "worker", cache: { enabled: true } },
      DocsTextCache: { type: "worker", cache: { enabled: true } },
      DocsClientAssetCache: { type: "worker", cache: { enabled: true } },
    });
    expect(config.vars.DOXA_PROD_TEXT_ROUTE_CACHE_MODE).toBe("all");
    expect(config.vars.DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE).toBe("on");
    expect(config.vars.DEBUG).toBe("false");
    expect(config.vars.DOXA_PROD_ROUTE_DATA_PREFETCH_MODE).toBe("all");
  });

  test("passes the route-data cache rollout into the deploy config", async () => {
    const fixture = await createFixture();
    const options = parseRendererPackageArgs(
      ["--route-data-cache-mode", "allowlist"],
      { DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS: "site-1" },
    );
    const result = await createRendererPackage({
      ...options,
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist",
    });

    const config = JSON.parse(
      await readFile(result.generatedConfigPath, "utf8"),
    );
    expect(config.vars.DOXA_PROD_ROUTE_DATA_CACHE_MODE).toBe("allowlist");
    expect(config.vars.DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS).toBe("site-1");
  });

  test("keeps the warm job's queues, Durable Objects, migration and cron", async () => {
    const fixture = await createFixture();
    const result = await createRendererPackage({
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist",
      dispatcherConfig: fileURLToPath(
        new URL("../wrangler.json", import.meta.url),
      ),
    });
    const config = JSON.parse(
      await readFile(result.generatedConfigPath, "utf8"),
    );
    const source = JSON.parse(
      await readFile(new URL("../wrangler.json", import.meta.url), "utf8"),
    );
    expect(config.queues).toEqual(source.queues);
    expect(config.durable_objects).toEqual(source.durable_objects);
    expect(config.migrations).toEqual([
      {
        tag: "v1",
        new_sqlite_classes: [
          "DocsWarmLock",
          "DocsWarmAnchor",
          "DocsRegionalWarmer",
          "DocsWarmControl",
        ],
      },
    ]);
    expect(config.triggers).toEqual({ crons: ["*/5 * * * *"] });
    expect(config.vars.DOXA_PROD_WARM_MODE).toBe("allowlist");
    expect(config.vars.DOXA_PROD_WARM_DEPLOY_SWEEP).toBe("on");
  });

  test("rejects an invalid route-data cache rollout", async () => {
    const fixture = await createFixture();
    await expect(
      createRendererPackage({
        appRoot: fixture.root,
        clientDir: "client",
        serverDir: "server",
        outputDir: "dist",
        routeDataCacheMode: "sometimes",
      }),
    ).rejects.toThrow(/Expected off, allowlist, or all/);
  });

  test("creates a deterministic package and deploy config", async () => {
    const fixture = await createFixture();

    const first = await createRendererPackage({
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist-a",
      mode: "allowlist",
      siteIds: "site-1",
      debug: "true",
    });
    const second = await createRendererPackage({
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist-b",
      mode: "allowlist",
      siteIds: "site-1",
      debug: "true",
    });

    expect(first.buildId).toBe(second.buildId);
    const raw = await gunzipAsync(await readFile(first.packagePath));
    const rendererPackage = JSON.parse(raw.toString("utf8"));
    expect(rendererPackage.modules).toEqual({
      "assets/chunk.js": "export const value = 1;",
      "index.js":
        'import { value } from "./assets/chunk.js"; export default value;',
    });

    const config = JSON.parse(
      await readFile(first.generatedConfigPath, "utf8"),
    );
    expect(config.vars.DOXA_PROD_DYNAMIC_RENDERER_MODE).toBe("allowlist");
    expect(config.vars.DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS).toBe("site-1");
    expect(config.vars.DEBUG).toBe("true");
    expect(config.vars.DOXA_RENDERER_BUILD_ID).toBe(first.buildId);
    expect(config.vars.DOXA_RENDERER_RELEASE_ID).toBe(
      first.rendererReleaseId,
    );
    expect(config.vars.DOXA_PROD_PRERENDER_MODE).toBe("off");
    expect(config.vars.DOXA_PROD_PRERENDER_SITE_IDS).toBe("");
    expect(config.vars.DOXA_PRERENDER_REPAIR_ENABLED).toBe("false");
    expect(config.vars.DOXA_PROD_ROUTE_DATA_CACHE_MODE).toBe("all");
    expect(config.vars.DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS).toBe("");
    expect(first.clientAssetManifestDigest).toHaveLength(64);
    expect(first.rendererReleaseId).toHaveLength(64);
    await expect(
      createRendererReleaseId({
        schemaVersion: 1,
        serverPackageDigest: first.buildId,
        clientAssetManifestDigest: first.clientAssetManifestDigest,
        outputSchemaVersion: first.outputSchemaVersion,
      }),
    ).resolves.toBe(first.rendererReleaseId);
    expect(config.assets.directory).toBe("../../docs-template/dist/client");
    expect(config.main).toBe("../src/index.ts");
    expect(config.cache).toEqual({ enabled: true });
  });

  test("keeps the release ID when only fixed-name client files change", async () => {
    const fixture = await createFixture();
    const pack = (outputDir) =>
      createRendererPackage({
        appRoot: fixture.root,
        clientDir: "client",
        serverDir: "server",
        outputDir,
      });
    await writeFile(path.join(fixture.root, "client/pages.json"), "[1]");
    await writeFile(path.join(fixture.root, "client/sitemap.xml"), "<a/>");
    const first = await pack("dist-a");

    // The template rebuilds these files with new timestamps on every build.
    await writeFile(path.join(fixture.root, "client/pages.json"), "[2]");
    await writeFile(path.join(fixture.root, "client/sitemap.xml"), "<b/>");
    const second = await pack("dist-b");
    expect(second.rendererReleaseId).toBe(first.rendererReleaseId);

    await writeFile(
      path.join(fixture.root, "client/assets/app.js"),
      "export const client = false;",
    );
    const third = await pack("dist-c");
    expect(third.rendererReleaseId).not.toBe(first.rendererReleaseId);
  });

  test("keeps the release ID when the client assets are planned for upload", async () => {
    const fixture = await createFixture();
    const pack = (outputDir) =>
      createRendererPackage({
        appRoot: fixture.root,
        clientDir: "client",
        serverDir: "server",
        outputDir,
      });
    const before = await pack("dist-a");
    const assetsDirectory = path.join(fixture.root, "client/assets");
    const files = await listClientAssetFiles(assetsDirectory);
    const plan = planClientAssetUploads({ assetsDirectory, files });
    const after = await pack("dist-b");

    // The upload covers exactly the files that the release ID digests.
    expect(plan.map((upload) => upload.key)).toEqual([
      "client-assets/v1/assets/app.js",
    ]);
    expect(after.rendererReleaseId).toBe(before.rendererReleaseId);
    // Pinned at 71062cb: the M27 upload must not change the release ID.
    expect(before.rendererReleaseId).toBe(
      "e6f289c2d279d9a772d87a734ff34fc2ee4c2e03adeb3d8d03acf53f7df359c4",
    );
  });

  test("enables every production site by default", async () => {
    const fixture = await createFixture();
    const result = await createRendererPackage({
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist",
    });

    const config = JSON.parse(
      await readFile(result.generatedConfigPath, "utf8"),
    );
    expect(config.vars.DOXA_PROD_DYNAMIC_RENDERER_MODE).toBe("all");
    expect(config.vars.DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS).toBe("");
    expect(config.vars.DOXA_PROD_ROUTE_DATA_CACHE_MODE).toBe("all");
    expect(config.vars.DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS).toBe("");
  });

  test("enables the route-data cache by default from the command line", () => {
    expect(parseRendererPackageArgs([], {})).toMatchObject({
      routeDataCacheMode: "all",
      routeDataCacheSiteIds: "",
    });
  });

  test("rejects an incomplete module graph", async () => {
    const fixture = await createFixture();
    await writeFile(
      path.join(fixture.root, "server/index.js"),
      'import "./assets/missing.js";',
    );

    await expect(
      createRendererPackage({
        appRoot: fixture.root,
        clientDir: "client",
        serverDir: "server",
        outputDir: "dist",
      }),
    ).rejects.toThrow("imports missing module");
  });

  test("rejects an invalid DEBUG value", async () => {
    const fixture = await createFixture();

    await expect(
      createRendererPackage({
        appRoot: fixture.root,
        clientDir: "client",
        serverDir: "server",
        outputDir: "dist",
        debug: "yes",
      }),
    ).rejects.toThrow("DEBUG");
  });

  test("keeps the committed pre-render rollout without a command-line value (F1)", async () => {
    const fixture = await createFixture(true, {
      DOXA_PROD_PRERENDER_MODE: "allowlist",
      DOXA_PROD_PRERENDER_SITE_IDS: "site-1,site-2",
    });
    const options = parseRendererPackageArgs([], {});
    const result = await createRendererPackage({
      ...options,
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist",
    });
    const config = JSON.parse(
      await readFile(result.generatedConfigPath, "utf8"),
    );
    expect(config.vars.DOXA_PROD_PRERENDER_MODE).toBe("allowlist");
    expect(config.vars.DOXA_PROD_PRERENDER_SITE_IDS).toBe("site-1,site-2");
  });

  test("lets a command-line or environment value override the committed rollout", async () => {
    const fixture = await createFixture(true, {
      DOXA_PROD_PRERENDER_MODE: "allowlist",
      DOXA_PROD_PRERENDER_SITE_IDS: "site-1",
    });
    for (const options of [
      parseRendererPackageArgs(["--prerender-mode", "off"], {}),
      parseRendererPackageArgs([], { DOXA_PROD_PRERENDER_MODE: "off" }),
    ]) {
      const result = await createRendererPackage({
        ...options,
        appRoot: fixture.root,
        clientDir: "client",
        serverDir: "server",
        outputDir: "dist",
      });
      const config = JSON.parse(
        await readFile(result.generatedConfigPath, "utf8"),
      );
      expect(config.vars.DOXA_PROD_PRERENDER_MODE).toBe("off");
      expect(config.vars.DOXA_PROD_PRERENDER_SITE_IDS).toBe("site-1");
    }
  });

  test("treats an empty pre-render environment value as unset", () => {
    expect(
      parseRendererPackageArgs([], {
        DOXA_PROD_PRERENDER_MODE: " ",
        DOXA_PROD_PRERENDER_SITE_IDS: "",
      }),
    ).toMatchObject({ prerenderMode: undefined, prerenderSiteIds: undefined });
  });

  test("leaves the previous build empty outside a deploy", async () => {
    const fixture = await createFixture();
    const result = await createRendererPackage({
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist",
    });
    const config = JSON.parse(
      await readFile(result.generatedConfigPath, "utf8"),
    );
    expect(config.vars.DOXA_PREVIOUS_RENDERER_BUILD_ID).toBe("");
    expect(config.vars.DOXA_PREVIOUS_RENDERER_RELEASE_ID).toBe("");
    expect(config.vars.DOXA_RENDERER_DEPLOYED_AT).toBe("");
  });

  test("writes the previous build of the release record into the deploy config", async () => {
    const fixture = await createFixture();
    const recordPath = path.join(fixture.root, "current.json");
    const record = {
      buildId: "1".repeat(64),
      releaseId: "2".repeat(64),
      packageKey: `renderer-code/${"1".repeat(64)}.json.gz`,
      deployedAt: "2026-10-01T00:00:00.000Z",
      previous: null,
      revoked: [],
    };
    await writeFile(recordPath, JSON.stringify(record));
    const pack = (args, outputDir) =>
      createRendererPackage({
        ...parseRendererPackageArgs(args, {}),
        appRoot: fixture.root,
        clientDir: "client",
        serverDir: "server",
        outputDir,
        now: "2026-10-29T12:00:00.000Z",
      });

    const on = await pack(
      ["--previous-fallback", "on", "--release-record", recordPath],
      "dist-on",
    );
    const onConfig = JSON.parse(await readFile(on.generatedConfigPath, "utf8"));
    expect(onConfig.vars.DOXA_PREVIOUS_RENDERER_BUILD_ID).toBe(record.buildId);
    expect(onConfig.vars.DOXA_PREVIOUS_RENDERER_RELEASE_ID).toBe(
      record.releaseId,
    );
    expect(onConfig.vars.DOXA_RENDERER_DEPLOYED_AT).toBe(
      "2026-10-29T12:00:00.000Z",
    );
    expect(on.previousBuild.reason).toBe("new_release");
    const metadata = JSON.parse(await readFile(on.metadataPath, "utf8"));
    expect(metadata.previousBuild).toEqual(on.previousBuild);

    const revoked = await pack(
      [
        "--previous-fallback",
        "on",
        "--release-record",
        recordPath,
        "--revoke",
        record.releaseId,
      ],
      "dist-revoked",
    );
    expect(revoked.previousBuild).toMatchObject({
      previous: null,
      reason: "revoked",
    });

    const off = await pack(
      ["--previous-fallback", "off", "--release-record", recordPath],
      "dist-off",
    );
    const offConfig = JSON.parse(
      await readFile(off.generatedConfigPath, "utf8"),
    );
    expect(offConfig.vars.DOXA_PREVIOUS_RENDERER_BUILD_ID).toBe("");
  });

  test("rejects an invalid previous-fallback value", async () => {
    const fixture = await createFixture();
    await expect(
      createRendererPackage({
        appRoot: fixture.root,
        clientDir: "client",
        serverDir: "server",
        outputDir: "dist",
        previousFallback: "yes",
      }),
    ).rejects.toThrow("Expected on or off");
  });

  test("preserves the disabled cache rollback setting", async () => {
    const fixture = await createFixture(false);
    const result = await createRendererPackage({
      appRoot: fixture.root,
      clientDir: "client",
      serverDir: "server",
      outputDir: "dist",
    });
    const config = JSON.parse(
      await readFile(result.generatedConfigPath, "utf8"),
    );
    expect(config.cache).toEqual({ enabled: false });
  });
});

async function createFixture(cacheEnabled = true, vars = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxa-renderer-package-"));
  await mkdir(path.join(root, "server/assets"), { recursive: true });
  await mkdir(path.join(root, "client/assets"), { recursive: true });
  await writeFile(
    path.join(root, "server/wrangler.json"),
    JSON.stringify({
      main: "index.js",
      compatibility_date: "2026-06-12",
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  await writeFile(
    path.join(root, "server/index.js"),
    'import { value } from "./assets/chunk.js"; export default value;',
  );
  await writeFile(
    path.join(root, "server/assets/chunk.js"),
    "export const value = 1;",
  );
  await writeFile(
    path.join(root, "client/assets/app.js"),
    "export const client = true;",
  );
  await writeFile(
    path.join(root, "wrangler.json"),
    JSON.stringify({
      name: "doxa-docs-renderer",
      main: "src/index.ts",
      cache: { enabled: cacheEnabled },
      assets: { directory: "../docs-template/dist/client" },
      vars,
    }),
  );
  return { root };
}
