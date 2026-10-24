import { describe, expect, test, vi } from "vitest";
import type { DocsHostResolution } from "@doxahq/contracts";
import { handleSiteAssetRequest } from "../src/site-assets";

const resolution: DocsHostResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "v1",
  artifactPrefix: "sites/site-1/versions/v1",
  manifestPath: "sites/site-1/versions/v1/manifest.json",
  accessPolicy: "public",
};
const hash = "a".repeat(64);
const url = `https://docs.example.com/_doxa/assets/${hash}`;

function dependencies(
  accessPolicy: DocsHostResolution["accessPolicy"] = "public",
) {
  return {
    resolveHost: vi.fn(async () => ({ ...resolution, accessPolicy })),
    runtime: {
      asset: vi.fn(
        async () =>
          new Response("image", { headers: { "content-type": "image/png" } }),
      ),
    },
    privateRenderer: {
      fetch: vi.fn(async () => new Response("Sign in", { status: 401 })),
    },
  };
}

describe("published site assets", () => {
  test("uses only the trusted host resolution", async () => {
    const deps = dependencies();
    const response = await handleSiteAssetRequest(
      new Request(`${url}?siteId=another-site`, {
        headers: { "x-doxa-site-id": "another-site" },
      }),
      deps,
    );
    expect(await response?.text()).toBe("image");
    expect(deps.resolveHost).toHaveBeenCalledWith("docs.example.com");
    expect(deps.runtime.asset).toHaveBeenCalledWith({ resolution, hash });
  });
  test("runs the access gate for private assets", async () => {
    const deps = dependencies("authenticated");
    const response = await handleSiteAssetRequest(new Request(url), deps);
    expect(response?.status).toBe(401);
    expect(deps.runtime.asset).not.toHaveBeenCalled();
    expect(deps.privateRenderer.fetch).toHaveBeenCalledOnce();
  });
  test("strips the body for HEAD requests", async () => {
    const response = await handleSiteAssetRequest(
      new Request(url, { method: "HEAD" }),
      dependencies(),
    );
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(await response?.text()).toBe("");
  });
  test.each([
    {
      name: "invalid hash",
      request: new Request("https://docs.example.com/_doxa/assets/no"),
      status: 404,
    },
    {
      name: "write method",
      request: new Request(url, { method: "POST" }),
      status: 405,
    },
  ])("rejects $name before resolution", async ({ request, status }) => {
    const deps = dependencies();
    expect((await handleSiteAssetRequest(request, deps))?.status).toBe(status);
    expect(deps.resolveHost).not.toHaveBeenCalled();
  });
  test("fails closed during a mixed release without asset support", async () => {
    const deps = dependencies();
    const response = await handleSiteAssetRequest(new Request(url), {
      ...deps,
      runtime: {},
    });
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });
});
