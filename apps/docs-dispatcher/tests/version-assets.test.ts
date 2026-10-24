import { describe, expect, test, vi } from "vitest";
import type { DocsHostResolution } from "@doxahq/contracts";
import { handleVersionAssetRequest } from "../src/version-assets";

const resolution: DocsHostResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "v1",
  artifactPrefix: "sites/site-1/versions/v1",
  manifestPath: "sites/site-1/versions/v1/manifest.json",
  accessPolicy: "public",
};
const url = "https://docs.example.com/assets/diagram.png";

function dependencies(
  accessPolicy: DocsHostResolution["accessPolicy"] = "public",
  status = 200,
) {
  return {
    resolveHost: vi.fn(async () => ({ ...resolution, accessPolicy })),
    runtime: {
      versionAsset: vi.fn(
        async () =>
          new Response(status === 200 ? "image" : null, {
            status,
            headers: { "content-type": "image/png" },
          }),
      ),
    },
  };
}

describe("published version images", () => {
  test("serves the image of the resolved version", async () => {
    const deps = dependencies();
    const response = await handleVersionAssetRequest(new Request(url), deps);
    expect(await response?.text()).toBe("image");
    expect(deps.resolveHost).toHaveBeenCalledWith("docs.example.com");
    expect(deps.runtime.versionAsset).toHaveBeenCalledWith({
      resolution,
      name: "diagram.png",
    });
  });

  test("passes the content hash of a pinned URL to the runtime", async () => {
    const deps = dependencies();
    const sha256 = "a".repeat(64);
    await handleVersionAssetRequest(new Request(`${url}?v=${sha256}`), deps);
    expect(deps.runtime.versionAsset).toHaveBeenCalledWith({
      resolution,
      name: "diagram.png",
      version: sha256,
    });
  });

  test("ignores a version that is not a content hash", async () => {
    const deps = dependencies();
    await handleVersionAssetRequest(new Request(`${url}?v=latest`), deps);
    expect(deps.runtime.versionAsset).toHaveBeenCalledWith({
      resolution,
      name: "diagram.png",
    });
  });

  test("strips the body for HEAD requests", async () => {
    const response = await handleVersionAssetRequest(
      new Request(url, { method: "HEAD" }),
      dependencies(),
    );
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(await response?.text()).toBe("");
  });

  test("leaves a private site to the renderer and its access gate", async () => {
    const deps = dependencies("authenticated");
    expect(await handleVersionAssetRequest(new Request(url), deps)).toBeNull();
    expect(deps.runtime.versionAsset).not.toHaveBeenCalled();
  });

  test("passes a miss on to the renderer", async () => {
    expect(
      await handleVersionAssetRequest(
        new Request(url),
        dependencies("public", 404),
      ),
    ).toBeNull();
  });

  test.each([
    "https://docs.example.com/assets/index-Bx9_a.js",
    "https://docs.example.com/assets/../manifest.json",
    "https://docs.example.com/guide",
    "https://docs.example.com/assets/Diagram.png",
  ])("ignores %s without a resolution", async (requestUrl) => {
    const deps = dependencies();
    expect(
      await handleVersionAssetRequest(new Request(requestUrl), deps),
    ).toBeNull();
    expect(deps.resolveHost).not.toHaveBeenCalled();
  });

  test("ignores write methods", async () => {
    const deps = dependencies();
    expect(
      await handleVersionAssetRequest(
        new Request(url, { method: "POST" }),
        deps,
      ),
    ).toBeNull();
    expect(deps.resolveHost).not.toHaveBeenCalled();
  });

  test("passes requests on during a mixed release without image support", async () => {
    const deps = dependencies();
    expect(
      await handleVersionAssetRequest(new Request(url), {
        resolveHost: deps.resolveHost,
        runtime: {},
      }),
    ).toBeNull();
  });
});
