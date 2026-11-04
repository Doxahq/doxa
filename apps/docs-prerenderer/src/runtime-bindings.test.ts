import { describe, expect, it, vi } from "vitest";

import {
  createRendererAdapter,
  type PrerenderRendererService,
} from "./runtime-bindings";

const resolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/version-1",
  manifestPath: "sites/site-1/versions/version-1/manifest.json",
  accessPolicy: "public" as const,
};

describe("createRendererAdapter", () => {
  it("renders every call with the task's own origin as the site URL", async () => {
    const service = {
      getPlan: vi.fn(async () => []),
      prepare: vi.fn(async () => ({})),
      render: vi.fn(async () => new Response("ok")),
    } satisfies PrerenderRendererService;
    const renderer = createRendererAdapter(
      service,
      resolution,
      "https://docs.acme.com",
    );

    await renderer.getPlan();
    await renderer.prepare("/guide");
    await renderer.render({
      pathname: "/guide",
      requestUrl: "https://docs.acme.com/guide",
      renderId: "a".repeat(64),
      routeData: {} as never,
    });

    const expected = { ...resolution, siteUrl: "https://docs.acme.com" };
    expect(service.getPlan).toHaveBeenCalledWith({ resolution: expected });
    expect(service.prepare).toHaveBeenCalledWith({
      resolution: expected,
      pathname: "/guide",
    });
    expect(service.render).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: expected }),
    );
  });
});
