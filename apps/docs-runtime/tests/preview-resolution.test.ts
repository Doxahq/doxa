import { afterEach, describe, expect, test, vi } from "vitest";
import {
  handleRuntimeSourceRequest,
  resetRuntimeSourceCachesForTests,
} from "../src/runtime-source";
import { createTreeBucket } from "./support/tree-bucket";

const PREVIEW_HOST = "doxa-demo-pr-42.doxa.page";
const ARTIFACT_PREFIX =
  "sites/site-1/versions/preview-version-1";

describe("preview hostname resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRuntimeSourceCachesForTests();
  });

  test("serves the preview channel version resolved by its host", async () => {
    const apiFetch = vi.fn(async () =>
      Response.json({
        site: {
          siteId: "site-1",
          projectId: "project-1",
          projectSlug: "doxa-demo",
          publishedVersionId: "preview-version-1",
          artifactPrefix: ARTIFACT_PREFIX,
          manifestPath: `${ARTIFACT_PREFIX}/manifest.json`,
          accessPolicy: "public",
        },
      })
    );
    vi.stubGlobal("fetch", apiFetch);
    const objects: Record<string, string> = {
      [`${ARTIFACT_PREFIX}/manifest.json`]: JSON.stringify({
        siteId: "site-1",
        versionId: "preview-version-1",
        projectSlug: "doxa-demo",
        generatedAt: "2026-07-23T12:00:00.000Z",
        pages: [{
          title: "Overview",
          href: "/",
          sourcePath: "source/index.mdx",
        }],
      }),
      [`${ARTIFACT_PREFIX}/source/index.mdx`]:
        "# Pull request preview",
    };
    const response = await handleRuntimeSourceRequest(
      new Request("https://runtime.test/runtime-source", {
        method: "POST",
        headers: {
          authorization: "Bearer runtime-token",
          "content-type": "application/json",
          "x-doxa-host": PREVIEW_HOST,
        },
        body: JSON.stringify({
          operation: "getRawPage",
          payload: { slug: "/" },
        }),
      }),
      {
        ALLOW_INTERNAL_HTTP: "true",
        API_BASE_URL: "https://api.doxa.test",
        DOCS_CONTENT_TOKEN: "runtime-token",
        DOCS_BUCKET: createBucket(objects),
      },
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      data: { body: "# Pull request preview" },
    });
    expect(apiFetch).toHaveBeenCalledWith(
      `https://api.doxa.test/internal/docs-hosts/${PREVIEW_HOST}`,
    );
  });
});

function createBucket(objects: Record<string, string>): R2Bucket {
  return createTreeBucket(objects).bucket;
}
