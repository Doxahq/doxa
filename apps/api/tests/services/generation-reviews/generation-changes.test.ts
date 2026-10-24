import { describe, expect, test } from "vitest";
import { relativeNavigationPathForSection } from "@doxahq/contracts/docs-branches";
import { buildArtifactPrefix, sourcePathForHref } from "@doxahq/docs-engine";

import type {
  ChangesVersion,
  GenerationChangesSnapshot,
} from "../../../src/repositories/generation-changes";
import { GenerationChangesService } from "../../../src/services/generation-reviews/generation-changes";
import {
  createInMemoryDocsContentStore,
  type InMemoryObjects,
} from "../../support/in-memory-docs-content-store";

const SITE_ID = "30000000-0000-4000-8000-000000000001";
const BASE_VERSION_ID = "30000000-0000-4000-8000-000000000002";
const PREVIEW_VERSION_ID = "30000000-0000-4000-8000-000000000003";
const JOB_ID = "30000000-0000-4000-8000-000000000004";
const SCOPE = { projectId: "project-1", ownerUserId: "owner-1" };

interface SiteFiles {
  nodes: Array<{ title: string; href: string }>;
  bodies: Record<string, string>;
}

function writeSite(objects: InMemoryObjects, versionId: string, site: SiteFiles): ChangesVersion {
  const prefix = buildArtifactPrefix(SITE_ID, versionId);
  const pages = site.nodes.map((node) => ({ ...node, sourcePath: sourcePathForHref(node.href) }));
  objects.set(
    `${prefix}/manifest.json`,
    JSON.stringify({ siteId: SITE_ID, versionId, projectSlug: "acme", generatedAt: "2026-10-16T00:00:00.000Z", pages }),
  );
  objects.set(`${prefix}/settings/sections.json`, JSON.stringify([{ slug: "default", label: "Docs", default: true }]));
  objects.set(`${prefix}/${relativeNavigationPathForSection("default")}`, JSON.stringify(site.nodes));
  for (const [href, body] of Object.entries(site.bodies)) {
    objects.set(`${prefix}/${sourcePathForHref(href)}`, body);
  }
  return { versionId, artifactPrefix: prefix, isCollected: false };
}

const BASE: SiteFiles = {
  nodes: [
    { title: "Intro", href: "/" },
    { title: "Environments", href: "/environments" },
    { title: "Legacy", href: "/legacy" },
  ],
  bodies: { "/": "intro", "/environments": "list environments", "/legacy": "old" },
};

/** The pull request adds a lookup endpoint, rewrites Environments, and drops Legacy. */
const PREVIEW: SiteFiles = {
  nodes: [
    { title: "Intro", href: "/" },
    { title: "Environments", href: "/environments" },
    { title: "Get an environment", href: "/get-environment" },
  ],
  bodies: {
    "/": "intro",
    "/environments": "list environments\n\nget one by key",
    "/get-environment": "GET /environments/{key}",
  },
};

function setup(overrides: Partial<GenerationChangesSnapshot> = {}) {
  const objects: InMemoryObjects = new Map();
  const base = writeSite(objects, BASE_VERSION_ID, BASE);
  const generated = writeSite(objects, PREVIEW_VERSION_ID, PREVIEW);
  const snapshot: GenerationChangesSnapshot = {
    jobId: JOB_ID,
    status: "succeeded",
    publicationMode: "preview",
    siteSlug: "acme",
    generated,
    base,
    ...overrides,
  };
  const service = new GenerationChangesService({
    changes: { snapshot: async () => snapshot },
    store: createInMemoryDocsContentStore(objects),
    previewUrl: ({ projectSlug, docsVersionId }) => `https://${projectSlug}--${docsVersionId.slice(0, 4)}.doxa.page`,
  });
  return { service };
}

describe("GenerationChangesService", () => {
  test("lists the pages that a preview run changed, compared with the version it was built on", async () => {
    const { service } = setup();

    const changes = await service.list(SCOPE, JOB_ID);

    expect(changes).toMatchObject({
      jobId: JOB_ID,
      baseVersionId: BASE_VERSION_ID,
      previewUrl: "https://acme--3000.doxa.page",
    });
    expect(changes.pages.map(({ href, change }) => ({ href, change }))).toEqual([
      { href: "/environments", change: "modified" },
      { href: "/get-environment", change: "added" },
      { href: "/legacy", change: "removed" },
    ]);
  });

  test("lists every page as new when the site had no version", async () => {
    const { service } = setup({ base: null });

    const changes = await service.list(SCOPE, JOB_ID);

    expect(changes.baseVersionId).toBeNull();
    expect(changes.pages.every((page) => page.change === "added")).toBe(true);
    expect(changes.pages).toHaveLength(3);
  });

  test("reads one page from both versions", async () => {
    const { service } = setup();

    await expect(service.pageSources(SCOPE, JOB_ID, "/environments")).resolves.toEqual({
      href: "/environments",
      published: "list environments",
      generated: "list environments\n\nget one by key",
    });
    await expect(service.pageSources(SCOPE, JOB_ID, "/legacy")).resolves.toMatchObject({
      published: "old",
      generated: null,
    });
    await expect(service.pageSources(SCOPE, JOB_ID, "/unknown")).rejects.toMatchObject({ code: "not_found" });
  });

  test("refuses a production run, which opens a review instead", async () => {
    const { service } = setup({ publicationMode: "production" });

    await expect(service.list(SCOPE, JOB_ID)).rejects.toMatchObject({ code: "invalid" });
  });

  test("refuses a run without a readable version", async () => {
    await expect(setup({ status: "failed", generated: null }).service.list(SCOPE, JOB_ID)).rejects.toMatchObject({
      code: "not_found",
      message: "This run wrote no documentation version.",
    });

    const { service } = setup({
      generated: { versionId: PREVIEW_VERSION_ID, artifactPrefix: "gone", isCollected: true },
    });
    await expect(service.list(SCOPE, JOB_ID)).rejects.toMatchObject({
      code: "not_found",
      message: "The files of this run were deleted after the retention period.",
    });
  });

  test("answers not found for a run outside the project", async () => {
    const service = new GenerationChangesService({
      changes: { snapshot: async () => null },
      store: createInMemoryDocsContentStore(new Map()),
      previewUrl: () => null,
    });

    await expect(service.list(SCOPE, JOB_ID)).rejects.toMatchObject({ code: "not_found" });
  });
});
