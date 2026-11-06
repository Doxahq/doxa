import type { DocsDomainResolution } from "@doxahq/contracts";
import { parsePublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";
import { describe, expect, test, vi } from "vitest";

import { createLiveRouteDataResponse } from "../src/live-route-data";
import { createRouteData } from "./fixtures/route-data";

const resolution: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/source-1",
  manifestPath: "sites/site-1/versions/source-1/manifest.json",
  accessPolicy: "public",
  hostname: "docs.example.com",
  domainKind: "custom_domain",
  renderTarget: "production",
};

describe("createLiveRouteDataResponse", () => {
  test("answers 200 with the route data that the renderer prepared", async () => {
    const warn = vi.fn();
    const response = await createLiveRouteDataResponse(
      { prepare: async () => parsePublicDocsRouteDataV1(createRouteData()) },
      resolution,
      "/guide",
      warn,
    );

    expect(response.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  test("logs the failure with the site and path, then answers 503", async () => {
    const warn = vi.fn();
    const response = await createLiveRouteDataResponse(
      {
        prepare: async () => {
          throw new Error('Unrecognized key: "searchProvider"');
        },
      },
      resolution,
      "/guide",
      warn,
    );

    expect(response.status).toBe(503);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("site-1");
    expect(warn.mock.calls[0]?.[0]).toContain('"/guide"');
    expect(warn.mock.calls[0]?.[0]).toContain(
      'Error: Unrecognized key: "searchProvider"',
    );
  });

  test("shortens a long error message in the log", async () => {
    const warn = vi.fn();
    await createLiveRouteDataResponse(
      {
        prepare: async () => {
          throw new Error("x".repeat(5000));
        },
      },
      resolution,
      "/guide",
      warn,
    );

    expect(String(warn.mock.calls[0]?.[0]).length).toBeLessThan(700);
  });
});
