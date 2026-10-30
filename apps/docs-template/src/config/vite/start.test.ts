import { describe, expect, test } from "vitest";

import { createStartConfig } from "./start";

describe("createStartConfig", () => {
  test("ships no static sitemap in the platform renderer build (RES-7)", () => {
    const config = createStartConfig("cloudflare", "https://docs.doxa.so", {
      staticSitemap: false,
    });

    expect(config.sitemap.enabled).toBe(false);
  });

  test("keeps the static sitemap of a build with its own content", () => {
    const config = createStartConfig("cloudflare", "https://docs.doxa.so", {
      staticSitemap: true,
    });

    expect(config.sitemap).toEqual({ enabled: true, host: "https://docs.doxa.so" });
  });
});
