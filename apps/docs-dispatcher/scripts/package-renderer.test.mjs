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
    });
    expect(config.vars.DEBUG).toBe("false");
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

async function createFixture(cacheEnabled = true) {
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
      vars: {},
    }),
  );
  return { root };
}
