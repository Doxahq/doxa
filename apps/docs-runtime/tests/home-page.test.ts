import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadFrozenArtifactSetByName } from "@doxahq/docs-artifact-fixtures";
import {
  resetRuntimeSourceCachesForTests,
  runResolvedRuntimeRequest,
  type RuntimeRequest,
  type RuntimeSourceEnv,
} from "../src/runtime-source";
import { createTreeBucket } from "./support/tree-bucket";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const set = loadFrozenArtifactSetByName(2, "starter");
const siteConfigKey = `${set.artifactPrefix}/settings/site.json`;

beforeEach(() => {
  resetRuntimeSourceCachesForTests();
});

afterEach(() => {
  resetRuntimeSourceCachesForTests();
});

describe("site home page", () => {
  test("shows the first page of the default section without a setting", async () => {
    const env = envWithSiteConfig({});
    expect(await run(env, "getHomeHref")).toEqual({ ok: true, data: "/" });
  });

  test("shows the chosen page at the site root", async () => {
    const env = envWithSiteConfig({ homePage: "/getting-started" });
    expect(await run(env, "getHomeHref")).toEqual({
      ok: true,
      data: "/getting-started",
    });
    const route = await run(env, "getRouteData", { pathname: "/" });
    expect(route).toMatchObject({
      ok: true,
      data: {
        homeHref: "/getting-started",
        page: { href: "/getting-started" },
      },
    });
  });

  test("shows the page at the root path when it is the chosen page", async () => {
    const env = envWithSiteConfig({ homePage: "/" });
    const route = await run(env, "getRouteData", { pathname: "/" });
    expect(route).toMatchObject({ ok: true, data: { page: { href: "/" } } });
  });

  test("falls back to the first page when the chosen page does not exist", async () => {
    const env = envWithSiteConfig({ homePage: "/deleted-page" });
    expect(await run(env, "getHomeHref")).toEqual({ ok: true, data: "/" });
  });
});

/** The frozen starter set, with fields added to its stored site config. */
function envWithSiteConfig(fields: Record<string, unknown>): RuntimeSourceEnv {
  const siteConfig = JSON.stringify({
    ...JSON.parse(set.objects[siteConfigKey]!),
    ...fields,
  });
  const manifest = {
    ...set.manifest,
    siteConfig: {
      path: "settings/site.json",
      sha256: createHash("sha256").update(siteConfig).digest("hex"),
    },
  };
  return {
    DOCS_BUCKET: createTreeBucket({
      ...set.objects,
      [siteConfigKey]: siteConfig,
      [set.manifestPath]: JSON.stringify(manifest),
    }).bucket,
    DOCS_CONTENT_TOKEN: "test-runtime-token",
    DOCS_PUBLIC_BASE_URL: "https://frozen.doxa.page",
  };
}

function run(
  env: RuntimeSourceEnv,
  operation: RuntimeRequest["operation"],
  payload?: unknown,
) {
  return runResolvedRuntimeRequest(env, {
    resolution: set.resolution,
    operation,
    payload,
  });
}
