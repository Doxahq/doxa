import { describe, expect, test, vi } from "vitest";

import { createBindingRuntimeSource } from "./binding-runtime-source";

describe("binding runtime source", () => {
  test("pins every content request to the dispatcher resolution", async () => {
    const request = vi.fn(async () => ({
      ok: true as const,
      data: {
        name: "Doxa Demo",
        description: "Generated docs",
        url: "https://demo.doxa.page",
      },
    }));
    const resolution = {
      siteId: "site-1",
      projectId: "project-1",
      projectSlug: "demo",
      publishedVersionId: "version-1",
      artifactPrefix: "sites/site-1/versions/version-1",
      manifestPath: "sites/site-1/versions/version-1/manifest.json",
      accessPolicy: "public" as const,
    };
    const source = createBindingRuntimeSource({
      binding: { request },
      resolution,
    });

    await expect(source.getSiteConfig()).resolves.toMatchObject({
      name: "Doxa Demo",
    });
    expect(request).toHaveBeenCalledWith({
      resolution,
      operation: "getSiteConfig",
    });
  });

  test("deduplicates identical operations inside one renderer request", async () => {
    const request = vi.fn(async () => ({ ok: true as const, data: [] }));
    const source = createBindingRuntimeSource({
      binding: { request },
      resolution: {
        siteId: "site-1",
        projectId: "project-1",
        projectSlug: "demo",
        publishedVersionId: "version-1",
        artifactPrefix: "sites/site-1/versions/version-1",
        manifestPath: "sites/site-1/versions/version-1/manifest.json",
        accessPolicy: "public",
      },
    });

    await Promise.all([source.getSections(), source.getSections()]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("supports shared rendering through a host-scoped binding", async () => {
    const request = vi.fn(async () => ({ ok: true as const, data: [] }));
    const source = createBindingRuntimeSource({
      binding: { request },
      hostname: "docs.example.com",
    });

    await source.getSections();

    expect(request).toHaveBeenCalledWith({
      hostname: "docs.example.com",
      operation: "getSections",
    });
  });
});
