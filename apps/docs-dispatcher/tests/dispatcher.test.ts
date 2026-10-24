import { describe, expect, test, vi } from "vitest";

import { dispatchDocsRequest } from "../src/dispatcher";

const resolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public" as const,
  hostname: "docs.example.com",
  domainKind: "custom_domain" as const,
  renderTarget: "production" as const,
};

describe("dispatchDocsRequest", () => {
  test("uses shared rendering without host resolution when the mode is off", async () => {
    const resolveHost = vi.fn(async () => resolution);
    const response = await dispatchDocsRequest({
      request: new Request("https://docs.example.com/guide"),
      mode: "off",
      allowedSiteIds: new Set(),
      resolveHost,
      renderShared: vi.fn(async () => new Response("shared")),
      renderDynamic: vi.fn(async () => new Response("dynamic")),
    });

    expect(await response.text()).toBe("shared");
    expect(response.headers.get("x-doxa-renderer-mode")).toBe("shared");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  test("uses dynamic rendering for an enabled production site", async () => {
    const response = await dispatchDocsRequest({
      request: new Request("https://docs.example.com/guide"),
      mode: "all",
      allowedSiteIds: new Set(),
      resolveHost: vi.fn(async () => resolution),
      renderShared: vi.fn(async () => new Response("shared")),
      renderDynamic: vi.fn(async () => new Response("dynamic")),
    });

    expect(await response.text()).toBe("dynamic");
    expect(response.headers.get("x-doxa-renderer-mode")).toBe("dynamic");
  });

  test("falls back to shared rendering after a safe dynamic request fails", async () => {
    const response = await dispatchDocsRequest({
      request: new Request("https://docs.example.com/api/search?q=guide"),
      mode: "all",
      allowedSiteIds: new Set(),
      resolveHost: vi.fn(async () => resolution),
      renderShared: vi.fn(async () => new Response("shared search")),
      renderDynamic: vi.fn(async () => {
        throw new Error("dynamic unavailable");
      }),
    });

    expect(await response.text()).toBe("shared search");
    expect(response.headers.get("x-doxa-renderer-mode")).toBe(
      "shared-fallback",
    );
  });

  test("falls back when a safe dynamic request returns a server error", async () => {
    const response = await dispatchDocsRequest({
      request: new Request("https://docs.example.com/guide"),
      mode: "all",
      allowedSiteIds: new Set(),
      resolveHost: vi.fn(async () => resolution),
      renderShared: vi.fn(async () => new Response("shared")),
      renderDynamic: vi.fn(async () => new Response("failed", { status: 503 })),
    });

    expect(await response.text()).toBe("shared");
    expect(response.headers.get("x-doxa-renderer-mode")).toBe(
      "shared-fallback",
    );
  });

  test("does not replay an unsafe request through the shared renderer", async () => {
    const renderShared = vi.fn(async () => new Response("shared"));

    await expect(
      dispatchDocsRequest({
        request: new Request("https://docs.example.com/action", {
          method: "POST",
        }),
        mode: "all",
        allowedSiteIds: new Set(),
        resolveHost: vi.fn(async () => resolution),
        renderShared,
        renderDynamic: vi.fn(async () => {
          throw new Error("dynamic unavailable");
        }),
      }),
    ).rejects.toThrow("dynamic unavailable");
    expect(renderShared).not.toHaveBeenCalled();
  });

  test("uses shared rendering when host resolution fails", async () => {
    const response = await dispatchDocsRequest({
      request: new Request("https://docs.example.com/guide"),
      mode: "all",
      allowedSiteIds: new Set(),
      resolveHost: vi.fn(async () => {
        throw new Error("api unavailable");
      }),
      renderShared: vi.fn(async () => new Response("shared")),
      renderDynamic: vi.fn(async () => new Response("dynamic")),
    });

    expect(await response.text()).toBe("shared");
    expect(response.headers.get("x-doxa-renderer-mode")).toBe("shared");
  });
});
