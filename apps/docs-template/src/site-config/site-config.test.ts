import { readFileSync } from "node:fs";

import { createElement } from "react";
import { listFrozenArtifactSets } from "@doxahq/docs-artifact-fixtures";
import {
  hashSiteConfig,
  resolveSiteConfig,
  siteConfigSchema,
  toClientSiteConfig,
} from "@doxahq/site-config";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Footer } from "../components/navigation/footer";
import { Navbar } from "../components/navigation/navbar";
import { createBindingRuntimeSource } from "../runtime/binding-runtime-source";
import { loadSiteConfig } from "./load-site-config";
import { SiteConfigProvider } from "./site-config-context";
import { siteHead } from "./site-head";
import { ThemeStyle } from "./theme-style";

vi.mock("../components/sidebar", () => ({ SheetLeft: () => null }));
vi.mock("../components/navigation/search-trigger", () => ({
  default: () => null,
}));
vi.mock("../components/theme-toggle", () => ({ ModeToggle: () => null }));
vi.mock("../components/chat/chat-button", () => ({ ChatButton: () => null }));
vi.mock("../components/anchor", () => ({
  default: ({
    href,
    children,
    target,
    rel,
  }: {
    href: string;
    children: string;
    target?: string;
    rel?: string;
  }) => createElement("a", { href, target, rel }, children),
}));

// Marks the links that navigate in the client, without a router in the test.
vi.mock("../lib/transition", () => ({
  Link: ({
    href,
    children,
    target,
  }: {
    href: string;
    children: string;
    target?: string;
  }) => createElement("a", { href, target, "data-client-link": "" }, children),
}));

const resolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "v1",
  artifactPrefix: "sites/site-1/versions/v1",
  manifestPath: "sites/site-1/versions/v1/manifest.json",
  accessPolicy: "public" as const,
};

describe("site config rollout", () => {
  it("uses the new operation with a current runtime", async () => {
    const config = resolveSiteConfig({ name: "Current" });
    const request = vi.fn(async () => ({ ok: true as const, data: config }));
    const source = createBindingRuntimeSource({
      resolution,
      binding: { request },
    });
    expect(await loadSiteConfig(source)).toEqual(config);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      resolution,
      operation: "getResolvedSiteConfig",
    });
  });
  it("falls back to legacy operations on an older runtime", async () => {
    const request = vi.fn(async (input: { operation: string }) => {
      if (input.operation === "getResolvedSiteConfig")
        return {
          ok: false as const,
          error: { code: "invalid_request", message: "Unknown operation" },
        };
      return {
        ok: true as const,
        data:
          input.operation === "getSiteConfig"
            ? {
                name: "Legacy",
                description: "Keep description",
                url: "https://example.com",
              }
            : resolveSiteConfig({ features: { rawMarkdown: false } }).features,
      };
    });
    const config = await loadSiteConfig(
      createBindingRuntimeSource({ resolution, binding: { request } })
    );
    expect(config.name).toBe("Legacy");
    expect(config.description).toBe("Keep description");
    expect(config.features.rawMarkdown).toBe(false);
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual([
      "getResolvedSiteConfig",
      "getSiteConfig",
      "getFeatureConfig",
    ]);
  });
  it("does not hide a runtime failure behind legacy defaults", async () => {
    const source = createBindingRuntimeSource({
      resolution,
      binding: {
        request: async () => ({
          ok: false,
          error: { code: "operation_failed", message: "Unavailable" },
        }),
      },
    });
    await expect(loadSiteConfig(source)).rejects.toMatchObject({
      code: "operation_failed",
    });
  });
});

describe("customized fixture chrome", () => {
  const set = listFrozenArtifactSets().find(
    (entry) => entry.schemaVersion === 2 && entry.name === "customized"
  );
  if (!set) throw new Error("The customized v2 fixture is required");
  const config = z
    .object({ data: siteConfigSchema })
    .parse(
      JSON.parse(readFileSync(set.expectedPath("site-config.json"), "utf8"))
    ).data;
  it("renders its theme in the head and its custom chrome in the body", async () => {
    const html = renderToStaticMarkup(
      createElement(
        "html",
        null,
        createElement(
          "head",
          null,
          createElement(ThemeStyle, {
            theme: config.theme,
            configHash: await hashSiteConfig(config),
          })
        ),
        createElement(
          "body",
          null,
          createElement(SiteConfigProvider, {
            config: toClientSiteConfig(config),
            children: [
              createElement(Navbar, { key: "nav" }),
              createElement(Footer, { key: "footer" }),
            ],
          })
        )
      )
    );
    expect(html).toMatch(/<head>[\s\S]*<style>[\s\S]*--primary: #123456/);
    expect(html).toContain("Start here");
    expect(html).toContain('href="https://example.com/blog"');
    expect(html).toMatch(/<a href="\/overview" data-client-link="">Start here<\/a>/);
    expect(html).toContain('href="https://example.com/pricing" rel="noopener noreferrer"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("Product");
    expect(html).toContain("Pricing");
    expect(html).toContain(`src="/_doxa/assets/${"a".repeat(64)}"`);
  });
  it("keeps the dehydrated root payload below 8 KiB", async () => {
    const client = toClientSiteConfig(config);
    expect(client).not.toHaveProperty("seo");
    const payload = {
      config: client,
      configHash: await hashSiteConfig(config),
      head: siteHead(config),
      delivery: null,
    };
    expect(
      new TextEncoder().encode(JSON.stringify(payload)).length
    ).toBeLessThan(8 * 1024);
  });
});
