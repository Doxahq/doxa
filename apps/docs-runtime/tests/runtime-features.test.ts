/**
 * PRODUCTION INCIDENT REGRESSION GUARDRAIL (2026-11-06).
 *
 * A site-settings publish stored `features.searchProvider`. The runtime sent
 * every site-config feature key to the renderer, and the strict route-data
 * parser rejected the unknown key. Every client navigation on the site then
 * got HTTP 503 from `/_doxa/route-data/v1`.
 *
 * Site config may hold flags that only the platform reads. The runtime must
 * send the renderer only the keys of the public route-data contract.
 */
import { describe, expect, test } from "vitest";
import { publicDocsFeatureConfigSchema } from "@doxahq/contracts/docs-prerender";
import { resolveSiteConfig } from "@doxahq/site-config";

import { runtimeFeatures } from "../src/site-config";

describe("runtimeFeatures", () => {
  test("drops site-config keys that the route-data contract does not name", () => {
    const config = resolveSiteConfig({
      name: "flagforge",
      features: {
        AgressiveNavPrefetch: true,
        searchProvider: "minisearch",
        apiPlayground: true,
        apiPlaygroundBaseUrl: "https://api.example.com/",
        apiPlaygroundTransport: "proxy",
        ai: { chat: true, chatWithPage: true, floatingInput: true },
      },
    });

    const features = runtimeFeatures(config);

    expect(() => publicDocsFeatureConfigSchema.parse(features)).not.toThrow();
    expect(features).not.toHaveProperty("searchProvider");
    expect(features).not.toHaveProperty("AgressiveNavPrefetch");
    expect(features).toMatchObject({
      apiPlayground: true,
      apiPlaygroundBaseUrl: "https://api.example.com/",
      apiPlaygroundTransport: "proxy",
      ai: { chat: true, chatWithPage: true, floatingInput: true },
    });
  });

  test("passes every key of the default site config through the strict contract", () => {
    const features = runtimeFeatures(resolveSiteConfig({ name: "docs" }));

    expect(() => publicDocsFeatureConfigSchema.parse(features)).not.toThrow();
  });
});
