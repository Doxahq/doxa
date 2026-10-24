import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { canonicalJson } from "@doxahq/contracts/docs-prerender";
import { resolveSiteConfig } from "@doxahq/site-config";
import { createSiteConfigArtifact } from "../src/site-config-writer";
import { createRuntimeDocsArtifacts } from "../src";

afterEach(() => vi.restoreAllMocks());

describe("v2 config writer", () => {
  test.each(["Published name", "Doxa 文档 – café 🚀"])(
    "stores resolved canonical bytes with their exact hash for %s",
    async (name) => {
      const config = resolveSiteConfig({
        name,
        theme: { preset: "brutalist" },
        navbar: { cta: { label: "Start", href: "/start" } },
      });
      const artifact = await createSiteConfigArtifact({
        projectName: "Different project name",
        siteConfig: config,
      });
      expect(artifact.file.content).toBe(canonicalJson(config));
      expect(artifact.manifestEntry).toEqual({
        path: "settings/site.json",
        sha256: createHash("sha256").update(artifact.file.content).digest("hex"),
      });
    },
  );

  test("keeps explicit site features over the legacy generation input", async () => {
    const artifact = await createSiteConfigArtifact({
      projectName: "Demo",
      siteConfig: { features: { apiPlayground: false } },
      features: { apiPlayground: true },
    });
    expect(JSON.parse(artifact.file.content).features.apiPlayground).toBe(
      false,
    );
  });

  test("restores required branding on the free plan without changing input", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const siteConfig = { branding: { poweredBy: false } };
    const artifact = await createSiteConfigArtifact({
      projectName: "Demo",
      siteConfig,
    });
    expect(JSON.parse(artifact.file.content).branding.poweredBy).toBe(true);
    expect(siteConfig.branding.poweredBy).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "site_config_entitlement_applied" }),
    );
  });

  test("keeps paid branding choices without logging enforcement", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const artifact = await createSiteConfigArtifact({
      projectName: "Demo",
      siteConfig: { branding: { poweredBy: false } },
      entitlements: { removePoweredBy: true, maxBranchesPerSite: 10 },
    });
    expect(JSON.parse(artifact.file.content).branding.poweredBy).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  test("writes only the v2 settings file for a first generation", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site",
      versionId: "version",
      projectSlug: "demo",
      projectName: "x".repeat(120),
      features: { apiPlayground: false },
      pages: [],
    });
    const artifact = bundle.files.find(
      (file) => file.path === "settings/site.json",
    );
    if (!artifact) throw new Error("Missing site config");
    expect(bundle.manifest.schemaVersion).toBe(2);
    expect(
      bundle.files.some((file) => file.path === "settings/features.json"),
    ).toBe(false);
    expect(JSON.parse(artifact.content)).toMatchObject({
      name: "x".repeat(80),
      features: { apiPlayground: false },
      branding: { poweredBy: true },
    });
  });
});
