import { describe, expect, test, vi } from "vitest";

import {
  createExpectedPrerenderIdentity,
  parsePrerenderMode,
  shouldUsePrerender,
} from "../src/prerender-policy";

describe("pre-render policy", () => {
  test("fails closed and warns for an invalid mode", () => {
    const warn = vi.fn();
    expect(parsePrerenderMode("sometimes", warn)).toBe("off");
    expect(warn).toHaveBeenCalledOnce();
  });

  test("supports all and allowlist without depending on Dynamic Workers", () => {
    expect(shouldUsePrerender("all", new Set(), "site-1")).toBe(true);
    expect(shouldUsePrerender("allowlist", new Set(["site-1"]), "site-1")).toBe(
      true,
    );
    expect(shouldUsePrerender("allowlist", new Set(), "site-1")).toBe(false);
    expect(shouldUsePrerender("off", new Set(["site-1"]), "site-1")).toBe(
      false,
    );
  });

  test("builds a host-scoped identity from trusted resolution", async () => {
    const common = {
      siteId: "site-1",
      artifactPrefix: "sites/site-1/versions/source-1",
      manifestPath: "sites/site-1/versions/source-1/manifest.json",
      rendererReleaseId: "a".repeat(64),
    };
    const custom = await createExpectedPrerenderIdentity({
      ...common,
      trustedRequestOrigin: "https://docs.example.com",
    });
    const generated = await createExpectedPrerenderIdentity({
      ...common,
      trustedRequestOrigin: "https://demo.doxa.page",
    });

    expect(custom.renderId).not.toBe(generated.renderId);
    expect(custom.sourceArtifactVersion).toBe("source-1");
    expect(custom.trustedRequestOrigin).toBe("https://docs.example.com");
  });
});
