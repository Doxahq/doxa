import { describe, expect, it, vi } from "vitest";
import { resolveSiteConfig } from "@doxahq/site-config";
import { readSiteConfig } from "../src/site-config-reader";
import { parseDocsManifest, type DocsManifestV2 } from "../src/manifest";

const base = {
  siteId: "site-a",
  versionId: "v2",
  projectSlug: "legacy-title",
  generatedAt: "2026-09-24",
  pages: [],
};
async function fixture(text: string) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const manifest: DocsManifestV2 = {
    ...base,
    schemaVersion: 2,
    siteConfig: { path: "settings/site.json", sha256: hash },
  };
  return {
    bytes,
    context: {
      manifest,
      artifactPrefix: "sites/site-a/versions/v2",
      projectName: "Project Name",
    },
  };
}

describe("site config artifact reader", () => {
  it("requires the v2 config path and exact digest shape", () => {
    for (const siteConfig of [
      undefined,
      { path: "../site.json", sha256: "a".repeat(64) },
      { path: "settings/site.json", sha256: "a".repeat(64) + "\n" },
    ]) {
      expect(
        parseDocsManifest({ ...base, schemaVersion: 2, siteConfig }),
      ).toEqual({ ok: false, reason: "invalid_manifest" });
    }
  });
  it("reads only the config inside the resolved artifact prefix", async () => {
    const f = await fixture(
      JSON.stringify({
        name: "Configured name",
        features: { ai: { chat: true } },
      }),
    );
    const read = vi.fn(async () => f.bytes);
    const config = await readSiteConfig({ read }, f.context);
    expect(read.mock.calls).toEqual([
      ["sites/site-a/versions/v2/settings/site.json"],
    ]);
    expect(config.name).toBe("Configured name");
    expect(config.features.ai.chat).toBe(true);
  });
  it("rejects one changed byte before parsing", async () => {
    const f = await fixture(JSON.stringify({ name: "Private brand" }));
    const changed = f.bytes.slice();
    changed[10] ^= 1;
    const log = vi.fn();
    expect(
      await readSiteConfig({ read: async () => changed }, f.context, log),
    ).toEqual(resolveSiteConfig({ name: "Project Name" }));
    expect(log).toHaveBeenCalledWith({
      event: "site_config_integrity_mismatch",
      artifactPrefix: f.context.artifactPrefix,
    });
  });
  it("drops invalid fields without logging rejected values", async () => {
    const f = await fixture(
      JSON.stringify({
        name: "Keep",
        theme: { primary: "</style>" },
        unexpected: "secret",
      }),
    );
    const log = vi.fn();
    expect(
      (await readSiteConfig({ read: async () => f.bytes }, f.context, log))
        .name,
    ).toBe("Keep");
    expect(log).toHaveBeenCalledWith({
      event: "site_config_fields_dropped",
      artifactPrefix: f.context.artifactPrefix,
      paths: expect.arrayContaining(["/theme/primary", "/unexpected"]),
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|style/);
  });
  it.each(["__proto__", "constructor", "prototype"])(
    "rejects unsafe raw key %s",
    async (key) => {
      const f = await fixture(`{"${key}":{},"name":"Rejected"}`);
      const log = vi.fn();
      expect(
        (await readSiteConfig({ read: async () => f.bytes }, f.context, log))
          .name,
      ).toBe("Project Name");
      expect(log).toHaveBeenCalledWith({
        event: "site_config_invalid",
        artifactPrefix: f.context.artifactPrefix,
      });
    },
  );
  it("preserves the published v1 title and description", async () => {
    const result = await readSiteConfig(
      { read: async () => new TextEncoder().encode('{"apiPlayground":false}') },
      {
        artifactPrefix: "sites/site-a/versions/v1",
        projectName: "Project Name",
        manifest: { ...base, schemaVersion: 1 },
      },
    );
    expect(result.name).toBe("legacy-title");
    expect(result.description).toBe("Documentation for legacy-title.");
    expect(result.features.apiPlayground).toBe(false);
  });
});
