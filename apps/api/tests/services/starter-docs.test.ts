import { beforeEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { parseDocsManifestText } from "@doxahq/docs-engine";
import { resolveSiteConfig } from "@doxahq/site-config";
import { createApiRouter } from "../../src/http/app";
import { createR2DocsContentStore } from "../../src/services/docs-content/store";
import { publishStarterDocs } from "../../src/services/starter-docs";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const mocks = vi.hoisted(() => ({
  markRunning: vi.fn(),
  project: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("../../src/repositories/jobs", () => ({
  JobsRepository: class {
    markRunning = mocks.markRunning;
  },
}));
vi.mock("../../src/repositories/projects", () => ({
  ProjectsRepository: class {
    getInternal = mocks.project;
  },
}));
vi.mock("../../src/repositories/docs", () => ({
  DocsRepository: class {
    publishJob = mocks.publish;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.project.mockResolvedValue({
    id: "project",
    siteId: "11111111-1111-4111-8111-111111111111",
    name: "Starter",
    slug: "starter",
  });
  mocks.publish.mockResolvedValue({ id: "version" });
});

test("starter publication writes a complete v2 bundle before publishing", async () => {
  const storage = createMemoryR2Bucket();
  mocks.publish.mockImplementation(async () => {
    // The version tree is the last write, so the version is complete here.
    expect(storage.calls.put.at(-1)).toMatch(/\/tree\.json$/);
    return { id: "version" };
  });
  const app = createApiRouter();
  app.post("/", async (c) =>
    c.json(
      await publishStarterDocs(c.env, { projectId: "project", jobId: "job" }),
    ),
  );
  const response = await app.request(
    "https://api.test/",
    { method: "POST" },
    { DOCS_BUCKET: storage.bucket },
  );
  expect(response.status).toBe(200);
  const { artifactPrefix, manifestPath } = mocks.publish.mock.calls[0][0];
  expect(manifestPath).toBe(`${artifactPrefix}/manifest.json`);
  const store = createR2DocsContentStore(storage.bucket);
  const manifestText = await store.read(manifestPath);
  const configText = await store.read(`${artifactPrefix}/settings/site.json`);
  if (!manifestText || !configText)
    throw new Error("Missing starter artifacts");
  const result = parseDocsManifestText(manifestText);
  if (!result.ok || result.manifest.schemaVersion !== 2)
    throw new Error("Expected v2 manifest");
  expect(result.manifest.siteConfig.sha256).toBe(
    createHash("sha256").update(configText).digest("hex"),
  );
  expect(JSON.parse(configText)).toEqual(
    resolveSiteConfig({ name: "Starter" }),
  );
  expect(await store.listKeys(`${artifactPrefix}/settings/`)).not.toContain(
    `${artifactPrefix}/settings/features.json`,
  );
  expect(mocks.markRunning).toHaveBeenCalledWith("job");
  expect(mocks.publish).toHaveBeenCalledWith(
    expect.objectContaining({ jobId: "job", reason: "starter_publication" }),
  );
});
