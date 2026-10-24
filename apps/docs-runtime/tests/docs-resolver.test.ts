import { afterEach, describe, expect, test, vi } from "vitest";
import {
  handleRuntimeSourceRequest,
  resetRuntimeSourceCachesForTests,
  runHostRuntimeRequest,
  type RuntimeSourceEnv,
} from "../src/runtime-source";
import { createTreeBucket, treeBucketOf } from "./support/tree-bucket";

const resolution = {
  siteId: "site-resolver",
  projectId: "project-resolver",
  projectSlug: "demo",
  publishedVersionId: "version-resolver",
  artifactPrefix: "sites/site-resolver/versions/version-resolver",
  manifestPath: "sites/site-resolver/versions/version-resolver/manifest.json",
  accessPolicy: "public",
  hostname: "demo.doxa.page",
  domainKind: "doxa_subdomain",
  renderTarget: "production",
};

function createEnv() {
  const env: RuntimeSourceEnv = {
    DOCS_RESOLVER: {
      fetch: vi.fn(async (request: Request) => {
        const input = await request.json();
        if (
          JSON.stringify(input) !==
            JSON.stringify({ kind: "host", value: "demo.doxa.page" }) &&
          JSON.stringify(input) !==
            JSON.stringify({ kind: "project", value: "project-resolver" })
        ) {
          throw new Error("Unexpected resolution identity");
        }
        return Response.json({ resolution });
      }),
    },
    DOCS_CONTENT_TOKEN: "test-token",
    DOCS_BUCKET: createTreeBucket({
      [resolution.manifestPath]: JSON.stringify({
        siteId: resolution.siteId,
        versionId: resolution.publishedVersionId,
        projectSlug: "demo",
        generatedAt: "2026-09-19T00:00:00.000Z",
        pages: [
          {
            title: "Overview",
            href: "/",
            sourcePath: "source/index.mdx",
          },
        ],
      }),
      [`${resolution.artifactPrefix}/source/index.mdx`]: "# Resolved version",
    }).bucket,
  };
  return env;
}

describe("runtime private docs resolver", () => {
  afterEach(() => {
    resetRuntimeSourceCachesForTests();
    vi.unstubAllGlobals();
  });

  test("reads artifacts only from the version resolved over the private binding", async () => {
    const env = createEnv();
    const result = await runHostRuntimeRequest(env, {
      hostname: "demo.doxa.page",
      operation: "getRawPage",
      payload: { slug: "/" },
    });
    expect(result).toMatchObject({
      ok: true,
      data: { body: "# Resolved version" },
    });
    expect(env.DOCS_BUCKET.get).toHaveBeenCalledWith(
      await treeBucketOf(env.DOCS_BUCKET).blobKeyOf(
        `${resolution.artifactPrefix}/source/index.mdx`,
      ),
    );
  });

  test("resolves project-scoped HTTP requests through the same private binding", async () => {
    const result = await handleRuntimeSourceRequest(
      new Request("https://runtime/runtime-source", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "x-doxa-project-id": "project-resolver",
        },
        body: JSON.stringify({
          operation: "getRawPage",
          payload: { slug: "/" },
        }),
      }),
      createEnv(),
    );
    expect(result?.status).toBe(200);
    expect(await result?.json()).toMatchObject({
      ok: true,
      data: { body: "# Resolved version" },
    });
  });

  test("does not fall back to public HTTP after a resolver failure", async () => {
    const env = createEnv();
    env.DOCS_RESOLVER = {
      fetch: async () => new Response("unavailable", { status: 503 }),
    };
    env.ALLOW_INTERNAL_HTTP = "true";
    const publicFetch = vi.fn();
    vi.stubGlobal("fetch", publicFetch);
    await expect(
      runHostRuntimeRequest(env, {
        hostname: "demo.doxa.page",
        operation: "getSiteConfig",
      }),
    ).rejects.toThrow("HTTP 503");
    expect(publicFetch).not.toHaveBeenCalled();
    expect(env.DOCS_BUCKET.get).not.toHaveBeenCalled();
  });
});
