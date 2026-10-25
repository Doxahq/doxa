import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { parseDocsManifestText } from "@doxahq/docs-engine";
// @ts-expect-error The generator is a plain Node script without types.
import { renderExampleDocsModule } from "../../scripts/generate-example-docs.mjs";
import { createR2DocsContentStore } from "../../src/services/docs-content/store";
import { createExampleDocsPages } from "../../src/services/example-docs/template";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const SITE_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  createWithoutRepository: vi.fn(),
  deleteForUser: vi.fn(),
  publishSeedVersion: vi.fn(),
}));
vi.mock("../../src/repositories/projects", () => ({
  ProjectsRepository: class {
    createWithoutRepository = mocks.createWithoutRepository;
  },
}));
vi.mock("../../src/repositories/project-deletion", () => ({
  ProjectDeletionRepository: class {
    deleteForUser = mocks.deleteForUser;
  },
}));
vi.mock("../../src/repositories/docs", () => ({
  DocsRepository: class {
    publishSeedVersion = mocks.publishSeedVersion;
  },
}));

const { createExampleProject } = await import(
  "../../src/services/example-docs/create-project"
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createWithoutRepository.mockResolvedValue({
    project: {
      id: "project-1",
      name: "Acme",
      slug: "acme",
      githubRepositoryId: null,
      publishedVersionId: null,
      docsUrl: null,
    },
    siteId: SITE_ID,
  });
  mocks.publishSeedVersion.mockImplementation(
    async (input: { versionId: string }) => ({ id: input.versionId }),
  );
});

describe("example docs template", () => {
  test("the generated bundle matches the MDX pages", async () => {
    const generated = await readFile(
      new URL(
        "../../src/services/example-docs/pages.generated.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(generated).toBe(await renderExampleDocsModule());
  });

  test("writes the project name into the home page as safe YAML", () => {
    const [home] = createExampleDocsPages('Acme "Cloud": API');
    expect(home.title).toBe('Acme "Cloud": API');
    expect(home.content).toContain('title: "Acme \\"Cloud\\": API"');
    expect(home.content).not.toContain("{{projectName}}");
  });

  test("the empty template has one home page with the project name", () => {
    const pages = createExampleDocsPages("Acme", "empty");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.route).toBe("/");
    expect(pages[0]?.content).toContain('title: "Acme"');
  });
});

describe("createExampleProject", () => {
  test("writes a complete v2 site to the version tree before it publishes the seed version", async () => {
    const storage = createMemoryR2Bucket();
    mocks.publishSeedVersion.mockImplementation(
      async (input: { versionId: string }) => {
        // The version tree is the last write, so the version is complete here.
        expect(storage.calls.put.at(-1)).toMatch(/\/tree\.json$/);
        return { id: input.versionId };
      },
    );

    const project = await createExampleProject(
      { DOCS_BUCKET: storage.bucket } as never,
      { userId: "user-1", name: "Acme" },
    );

    const [seed] = mocks.publishSeedVersion.mock.calls[0];
    expect(seed.siteId).toBe(SITE_ID);
    expect(seed.artifactPrefix).toBe(
      `sites/${SITE_ID}/versions/${seed.versionId}`,
    );
    expect(seed.manifestPath).toBe(`${seed.artifactPrefix}/manifest.json`);
    expect(project.publishedVersionId).toBe(seed.versionId);

    // Read back the way the editor and the renderer do.
    const store = createR2DocsContentStore(storage.bucket);
    const manifest = parseDocsManifestText(
      (await store.read(seed.manifestPath)) ?? "",
    );
    if (!manifest.ok || manifest.manifest.schemaVersion !== 2) {
      throw new Error("Expected a v2 manifest");
    }
    expect(manifest.manifest.pages.map((page) => page.href)).toEqual([
      "/",
      "/quickstart",
      "/writing/formatting",
      "/writing/code-blocks",
      "/writing/components",
      "/writing/diagrams",
      "/publishing/navigation",
      "/publishing/publish",
      "/api",
      "/api/notes/create",
    ]);
    const sections = JSON.parse(
      (await store.read(`${seed.artifactPrefix}/settings/sections.json`)) ??
        "[]",
    );
    expect(JSON.stringify(sections)).toContain("API Reference");
    expect(
      await store.listKeys(`${seed.artifactPrefix}/source/`),
    ).toHaveLength(10);
    expect(mocks.deleteForUser).not.toHaveBeenCalled();
  });

  test("the empty template publishes one introduction page", async () => {
    const storage = createMemoryR2Bucket();

    await createExampleProject({ DOCS_BUCKET: storage.bucket } as never, {
      userId: "user-1",
      name: "Acme",
      template: "empty",
    });

    expect(mocks.createWithoutRepository).toHaveBeenCalledWith({
      userId: "user-1",
      name: "Acme",
    });
    const [seed] = mocks.publishSeedVersion.mock.calls[0];
    const store = createR2DocsContentStore(storage.bucket);
    const manifest = parseDocsManifestText(
      (await store.read(seed.manifestPath)) ?? "",
    );
    if (!manifest.ok || manifest.manifest.schemaVersion !== 2) {
      throw new Error("Expected a v2 manifest");
    }
    expect(manifest.manifest.pages.map((page) => page.href)).toEqual(["/"]);
    expect(manifest.manifest.pages[0]?.title).toBe("Acme");
    expect(
      await store.listKeys(`${seed.artifactPrefix}/source/`),
    ).toHaveLength(1);
  });

  test("removes the project when the example cannot be published", async () => {
    const { bucket } = createMemoryR2Bucket();
    mocks.publishSeedVersion.mockRejectedValue(new Error("database down"));

    await expect(
      createExampleProject({ DOCS_BUCKET: bucket } as never, {
        userId: "user-1",
        name: "Acme",
      }),
    ).rejects.toThrow("database down");
    expect(mocks.deleteForUser).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
    });
  });
});
