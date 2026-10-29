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

  test("logs each fallback with the status or the error, and the path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      mode: "all" as const,
      allowedSiteIds: new Set<string>(),
      resolveHost: vi.fn(async () => resolution),
      renderShared: vi.fn(async () => new Response("shared")),
    };

    await dispatchDocsRequest({
      ...input,
      request: new Request("https://docs.example.com/llms.txt"),
      renderDynamic: vi.fn(async () => new Response("failed", { status: 503 })),
    });
    await dispatchDocsRequest({
      ...input,
      request: new Request("https://docs.example.com/guide"),
      renderDynamic: vi.fn(async () => {
        throw new Error("subrequest limit");
      }),
    });

    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        event: "docs_renderer_fallback",
        siteId: "site-1",
        publishedVersionId: "version-1",
        path: "/llms.txt",
        status: 503,
      },
      {
        event: "docs_renderer_fallback",
        siteId: "site-1",
        publishedVersionId: "version-1",
        path: "/guide",
        error: "Error: subrequest limit",
      },
    ]);
    warn.mockRestore();
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

  describe("renderer_props_missing (F35)", () => {
    const propsMissing = () =>
      new Response("The renderer request has no scope.", {
        status: 500,
        headers: { "x-doxa-renderer-error": "renderer_props_missing" },
      });

    test("logs the code before the shared-renderer fallback", async () => {
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const renderShared = vi.fn(async () => new Response("shared"));
      const response = await dispatchDocsRequest({
        request: new Request("https://docs.example.com/guide"),
        mode: "all",
        allowedSiteIds: new Set(),
        resolveHost: vi.fn(async () => resolution),
        renderShared,
        renderDynamic: vi.fn(async () => propsMissing()),
      });

      expect(await response.text()).toBe("shared");
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
        event: "renderer_props_missing",
        entrypoint: "fetch",
        siteId: "site-1",
        publishedVersionId: "version-1",
        fallback: true,
      });
      expect(error.mock.invocationCallOrder[0]).toBeLessThan(
        renderShared.mock.invocationCallOrder[0] ?? 0,
      );
      error.mockRestore();
    });

    test("logs a thrown props-missing error", async () => {
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      await dispatchDocsRequest({
        request: new Request("https://docs.example.com/guide"),
        mode: "all",
        allowedSiteIds: new Set(),
        resolveHost: vi.fn(async () => resolution),
        renderShared: vi.fn(async () => new Response("shared")),
        renderDynamic: vi.fn(async () => {
          throw new Error(
            "[renderer_props_missing] The renderer call has no request scope in its entrypoint props.",
          );
        }),
      });
      expect(String(error.mock.calls[0]?.[0])).toContain(
        '"event":"renderer_props_missing"',
      );
      error.mockRestore();
    });

    test("returns the 5xx without content for an unsafe request", async () => {
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const response = await dispatchDocsRequest({
        request: new Request("https://docs.example.com/guide", {
          method: "POST",
        }),
        mode: "all",
        allowedSiteIds: new Set(),
        resolveHost: vi.fn(async () => resolution),
        renderShared: vi.fn(async () => new Response("shared")),
        renderDynamic: vi.fn(async () => propsMissing()),
      });
      expect(response.status).toBe(500);
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
        event: "renderer_props_missing",
        fallback: false,
      });
      error.mockRestore();
    });

    test("does not log other server errors as missing props", async () => {
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      await dispatchDocsRequest({
        request: new Request("https://docs.example.com/guide"),
        mode: "all",
        allowedSiteIds: new Set(),
        resolveHost: vi.fn(async () => resolution),
        renderShared: vi.fn(async () => new Response("shared")),
        renderDynamic: vi.fn(
          async () => new Response("failed", { status: 503 }),
        ),
      });
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });
});
