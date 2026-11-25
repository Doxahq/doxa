import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  generationContextSchema,
  type GenerationContext,
} from "@doxahq/contracts";
import {
  createRuntimeDocsArtifacts,
  writeVersionTree,
} from "@doxahq/docs-engine";
import { createApiRouter } from "../../src/http/app";
import { withGenerationSiteConfig } from "../../src/services/generation-site-config";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), starterOnly: vi.fn() }));
vi.mock("../../src/repositories/docs", () => ({
  DocsRepository: class {
    resolveByProjectId = mocks.resolve;
    holdsOnlyStarterContent = mocks.starterOnly;
  },
}));

const context: GenerationContext = {
  project: {
    id: "project",
    siteId: "site",
    name: "Project",
    slug: "project",
    siteSlug: "project",
  },
  repository: {
    id: "repo",
    fullName: "owner/repo",
    defaultBranch: "main",
    installationId: "installation",
  },
};
const prefix = "sites/site/versions/published";
const resolution = {
  projectId: "project",
  siteId: "site",
  artifactPrefix: prefix,
  manifestPath: `${prefix}/manifest.json`,
};

/**
 * `objects` holds logical files of the published version. The request stores
 * them as one version tree, like a publication does.
 */
function fixture() {
  const objects = new Map<string, string>();
  const storage = createMemoryR2Bucket();
  const get = vi.fn((key: string) => storage.bucket.get(key));
  const request = async (value: GenerationContext | null = context) => {
    if (objects.size > 0) {
      await writeVersionTree(storage.bucket, {
        siteId: "site",
        versionId: "published",
        files: [...objects].map(([key, content]) => ({
          path: key.slice(prefix.length + 1),
          content,
          contentType: "text/plain; charset=utf-8",
        })),
      });
    }
    const app = createApiRouter();
    app.get("/", async (c) =>
      c.json(await withGenerationSiteConfig(c.env, value)),
    );
    return app.request(
      "https://api.test/",
      {},
      { DOCS_BUCKET: { ...storage.bucket, get } },
    );
  };
  return { objects, get, request };
}

describe("generation settings snapshot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolve.mockResolvedValue(resolution);
    mocks.starterOnly.mockResolvedValue(false);
  });

  test("allows branding while the site holds only starter content", async () => {
    mocks.resolve.mockResolvedValue(null);
    mocks.starterOnly.mockResolvedValue(true);
    const { request } = fixture();
    const result = generationContextSchema.parse(
      await (await request()).json(),
    );
    expect(result.brandingEligible).toBe(true);
    expect(mocks.starterOnly).toHaveBeenCalledWith("project");
  });

  test("does not allow branding after a real publication", async () => {
    const { objects, request } = fixture();
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site",
      versionId: "published",
      projectSlug: "project",
      projectName: "Project",
      pages: [],
    });
    for (const file of bundle.files)
      objects.set(`${prefix}/${file.path}`, file.content);
    const response = await request();
    expect(response.status).toBe(200);
    const result = generationContextSchema.parse(await response.json());
    expect(result.siteConfig).toBeDefined();
    expect(result.brandingEligible).toBe(false);
    expect(mocks.starterOnly).toHaveBeenCalledWith("project");
  });

  test("does not look up settings for a missing project", async () => {
    const { request, get } = fixture();
    await expect((await request(null)).json()).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  test("uses writer defaults for the first generation", async () => {
    mocks.resolve.mockResolvedValue(null);
    const { request, get } = fixture();
    const result = generationContextSchema.parse(
      await (await request()).json(),
    );
    expect(result.siteConfig).toBeUndefined();
    expect(result.entitlements).toEqual({ removePoweredBy: false, maxBranchesPerSite: 10 });
    expect(get).not.toHaveBeenCalled();
  });

  test("preserves settings from the published version through the actual writer", async () => {
    const { objects, request, get } = fixture();
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site",
      versionId: "published",
      projectSlug: "project",
      projectName: "Project",
      pages: [],
      siteConfig: {
        name: "Custom name",
        theme: { preset: "brutalist" },
        features: { apiPlayground: false },
        navbar: { cta: { label: "Start", href: "/start" } },
      },
    });
    for (const file of bundle.files)
      objects.set(`${prefix}/${file.path}`, file.content);
    // The source baseline is deliberately not used to select the settings version.
    const executionContext = {
      ...context,
      baselineVersion: {
        artifactPrefix: "sites/site/versions/older-source-baseline",
      },
    };
    const response = await request(executionContext);
    expect(response.status).toBe(200);
    const result = generationContextSchema.parse(await response.json());
    const next = await createRuntimeDocsArtifacts({
      siteId: "site",
      versionId: "next",
      projectSlug: "project",
      projectName: "Project",
      pages: [],
      siteConfig: result.siteConfig,
      entitlements: result.entitlements,
    });
    expect(
      next.files.find((file) => file.path === "settings/site.json")?.content,
    ).toBe(
      bundle.files.find((file) => file.path === "settings/site.json")?.content,
    );
    // One tree read, then the blobs of the manifest and the settings.
    const keys = get.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(`${prefix}/tree.json`);
    expect(keys.slice(1).every((key) => key.startsWith("sites/site/blobs/"))).toBe(
      true,
    );
  });

  test("reads legacy settings with the shared reader", async () => {
    const { objects, request } = fixture();
    objects.set(
      `${prefix}/manifest.json`,
      JSON.stringify({
        siteId: "site",
        versionId: "published",
        projectSlug: "project",
        generatedAt: new Date(0).toISOString(),
        pages: [],
      }),
    );
    objects.set(
      `${prefix}/settings/features.json`,
      JSON.stringify({ apiPlayground: false }),
    );
    const response = await request();
    expect(response.status).toBe(200);
    const result = generationContextSchema.parse(await response.json());
    expect(result.siteConfig?.features.apiPlayground).toBe(false);
  });

  test.each([
    { siteId: "other-site", projectId: "project" },
    { siteId: "site", projectId: "other-project" },
  ])("rejects a cross-project resolution: %j", async (identity) => {
    mocks.resolve.mockResolvedValue({ ...resolution, ...identity });
    const { request, get } = fixture();
    expect((await request()).status).toBe(500);
    expect(get).not.toHaveBeenCalled();
  });

  test.each([
    undefined,
    "not json",
    JSON.stringify({
      siteId: "other-site",
      versionId: "version",
      projectSlug: "project",
      generatedAt: new Date(0).toISOString(),
      pages: [],
    }),
  ])(
    "rejects a missing or invalid published manifest: %s",
    async (manifest) => {
      const { request, objects } = fixture();
      if (manifest !== undefined)
        objects.set(`${prefix}/manifest.json`, manifest);
      expect((await request()).status).toBe(500);
    },
  );
});
