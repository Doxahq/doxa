import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { docsContentOverviewSchema } from "@doxahq/contracts";
import {
  createDocsBranchInputSchema,
  siteIdSchema,
  versionIdSchema,
} from "@doxahq/contracts/docs-branches";
import { InMemoryDocsBranchStore } from "../support/in-memory-docs-branches";
import type { PublishedDocsContentVersion } from "../../src/repositories/docs-content";
import { DocsContentService } from "../../src/services/docs-content/service";
import { freePlanEntitlements } from "../../src/services/free-plan-entitlements";
import { createInMemoryDocsContentStore } from "../support/in-memory-docs-content-store";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const siteId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const prefix = buildArtifactPrefix(siteId, versionId);
const actor = { userId, origin: "editor" } as const;

function fixture() {
  const objects = new Map<string, string>([
    [
      `${prefix}/manifest.json`,
      JSON.stringify({
        siteId,
        versionId,
        projectSlug: "example",
        generatedAt: "2026-09-24T00:00:00.000Z",
        pages: [{ href: "/", title: "Home", sourcePath: "source/index.mdx" }],
      }),
    ],
    [`${prefix}/source/index.mdx`, "---\ntitle: Home\n---\n\n# Home\n"],
    [
      `${prefix}/settings/sections.json`,
      JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
    ],
    [
      `${prefix}/settings/documents.json`,
      JSON.stringify([{ title: "Home", href: "/" }]),
    ],
  ]);
  const store = createInMemoryDocsContentStore(objects);
  const main: PublishedDocsContentVersion = {
    projectId,
    projectName: "Example",
    projectSlug: "example",
    siteId,
    versionId,
    versionNumber: 1,
    artifactPrefix: prefix,
    manifestPath: `${prefix}/manifest.json`,
    createdAt: new Date("2026-09-24T00:00:00.000Z"),
  };
  const branches = new InMemoryDocsBranchStore();
  branches.addSite(userId, {
    id: siteIdSchema.parse(siteId),
    projectId,
    projectName: "Example",
    projectSlug: "example",
    mainVersionId: versionIdSchema.parse(versionId),
    mainVersionNumber: 1,
    mainArtifactPrefix: prefix,
    mainCreatedAt: main.createdAt,
  });
  const service = new DocsContentService({
    store,
    branches,
    entitlements: freePlanEntitlements,
    assets: { head: async () => null },
  });
  return { service, branches, objects };
}

describe("DocsContentService branch storage", () => {
  let env: ReturnType<typeof fixture>;
  beforeEach(() => {
    env = fixture();
  });

  test("reads main without creating a hidden branch", async () => {
    const overview = await env.service.getOverview(actor, projectId);
    expect(overview.working).toMatchObject({
      branchId: null,
      baseVersionId: versionId,
      changeCount: 0,
      revision: 0,
    });
    expect(overview.pages[0]).toMatchObject({ href: "/", status: "published" });
    expect(docsContentOverviewSchema.safeParse(overview).success).toBe(true);
    expect(
      await env.branches.getBranchForUser({
        userId,
        projectId,
        branch: "main",
      }),
    ).toBeNull();
  });

  test("first edit creates a hidden branch and a hashed change row without R2 draft writes", async () => {
    const working = await env.service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: "# Edited" },
    ]);
    expect(working).toMatchObject({
      changeCount: 1,
      editedHrefs: ["/"],
      revision: 1,
    });
    const changes = await env.branches.listChanges({
      userId,
      projectId,
      branch: "main",
    });
    expect(changes[0]).toMatchObject({
      path: "source/index.mdx",
      kind: "upsert",
      content: "# Edited",
      byteSize: 8,
    });
    expect(changes[0]?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      [...env.objects.keys()].some((key) => key.includes("/drafts/")),
    ).toBe(false);
    const page = await env.service.getPage(actor, projectId, "/");
    expect(page.workingContent).toBe("# Edited");
    expect(page.publishedContent).toContain("# Home");
  });

  test("a rejected edit and a base-equivalent edit do not create a branch", async () => {
    await expect(
      env.service.applyEdits(actor, projectId, [
        { type: "set_site_config", config: { branding: { poweredBy: false } } },
      ]),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "entitlement_required" })],
    });
    const base = env.objects.get(`${prefix}/source/index.mdx`);
    await env.service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: base ?? "" },
    ]);
    expect(
      await env.branches.getBranchForUser({
        userId,
        projectId,
        branch: "main",
      }),
    ).toBeNull();
  });

  test("parallel first edits create one hidden branch and preserve different paths", async () => {
    await Promise.all([
      env.service.applyEdits(actor, projectId, [
        { type: "set_page_content", href: "/", content: "# First" },
      ]),
      env.service.applyEdits(actor, projectId, [
        { type: "set_site_config", config: { name: "My docs" } },
      ]),
    ]);
    const branch = await env.branches.getBranchForUser({
      userId,
      projectId,
      branch: "main",
    });
    expect(branch?.revision).toBe(2);
    expect(
      await env.branches.listChanges({ userId, projectId, branch: "main" }),
    ).toHaveLength(2);
  });

  test("restoring base content removes the working row", async () => {
    await env.service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: "# Edited" },
    ]);
    const base = env.objects.get(`${prefix}/source/index.mdx`);
    expect(base).toBeDefined();
    await env.service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: base ?? "" },
    ]);
    expect(
      await env.branches.listChanges({ userId, projectId, branch: "main" }),
    ).toHaveLength(0);
  });

  test("site settings are a working row and reset removes only that row", async () => {
    await env.service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: "# Edited" },
      { type: "set_site_config", config: { name: "My docs" } },
    ]);
    const overview = await env.service.getOverview(actor, projectId);
    expect(overview.siteConfig.working?.name).toBe("My docs");
    expect(overview.working.changeCount).toBe(2);
    await env.service.applyEdits(actor, projectId, [
      { type: "reset_site_config" },
    ]);
    const after = await env.service.getOverview(actor, projectId);
    expect(after.siteConfig.working).toBeNull();
    expect(after.working.changeCount).toBe(1);
  });

  test("structure edits write manifest, navigation, and new page content as rows", async () => {
    await env.service.applyEdits(actor, projectId, [
      {
        type: "create_page",
        sectionSlug: "default",
        groupIndex: null,
        title: "Guide",
        slug: "guide",
      },
    ]);
    const paths = (
      await env.branches.listChanges({ userId, projectId, branch: "main" })
    ).map((row) => row.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "settings/sections.json",
        "settings/documents.json",
        "source/guide/index.mdx",
      ]),
    );
    const overview = await env.service.getOverview(actor, projectId);
    expect(overview.pages.map((page) => page.href)).toContain("/guide");
    expect(
      (await env.service.getPage(actor, projectId, "/guide")).workingContent,
    ).toContain("Guide");
  });

  test("a new group starts empty and the overview lists it", async () => {
    await env.service.applyEdits(actor, projectId, [
      { type: "create_group", sectionSlug: "default", heading: "Recipes" },
    ]);
    const overview = await env.service.getOverview(actor, projectId);
    expect(overview.pages.map((page) => page.href)).toEqual(["/"]);
    expect(overview.navigation[0]?.groups).toEqual([
      { heading: null, groupIndex: null, hrefs: ["/"] },
      { heading: "Recipes", groupIndex: 0, hrefs: [] },
    ]);
    expect(docsContentOverviewSchema.safeParse(overview).success).toBe(true);
  });

  test("a new group takes its first page from the same edit list", async () => {
    await env.service.applyEdits(actor, projectId, [
      { type: "create_group", sectionSlug: "default", heading: "Recipes" },
      { type: "create_group", sectionSlug: "default", heading: "Later" },
      {
        type: "create_page",
        sectionSlug: "default",
        groupIndex: 1,
        title: "Bake",
        slug: "bake",
      },
    ]);
    const overview = await env.service.getOverview(actor, projectId);
    expect(overview.pages.map((page) => page.href)).toEqual(["/", "/bake"]);
    // The empty group keeps its place before the filled one.
    expect(overview.navigation[0]?.groups).toEqual([
      { heading: null, groupIndex: null, hrefs: ["/"] },
      { heading: "Recipes", groupIndex: 0, hrefs: [] },
      { heading: "Later", groupIndex: 1, hrefs: ["/bake"] },
    ]);
  });

  test("the dashboard's starter page still comes with create_group", async () => {
    await env.service.applyEdits(actor, projectId, [
      {
        type: "create_group",
        sectionSlug: "default",
        heading: "Recipes",
        starterPage: true,
      },
    ]);
    const overview = await env.service.getOverview(actor, projectId);
    expect(overview.navigation[0]?.groups.at(-1)).toEqual({
      heading: "Recipes",
      groupIndex: 0,
      hrefs: ["/new-page"],
    });
  });

  test("deleting a page stores a tombstone and removes it from the effective tree", async () => {
    await env.service.applyEdits(actor, projectId, [
      {
        type: "create_page",
        sectionSlug: "default",
        groupIndex: null,
        title: "Guide",
        slug: "guide",
      },
    ]);
    await env.service.applyEdits(actor, projectId, [
      { type: "delete_page", href: "/" },
    ]);
    const changes = await env.branches.listChanges({
      userId,
      projectId,
      branch: "main",
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        path: "source/index.mdx",
        kind: "delete",
        content: null,
      }),
    );
    expect(
      (await env.service.getOverview(actor, projectId)).pages.map(
        (page) => page.href,
      ),
    ).toEqual(["/guide"]);
  });

  test("another user cannot read or edit the project", async () => {
    const other = { userId: "someone-else", origin: "editor" } as const;
    await expect(
      env.service.getOverview(other, projectId),
    ).rejects.toMatchObject({ code: "branch_not_found" });
    await expect(
      env.service.applyEdits(other, projectId, [
        { type: "set_page_content", href: "/", content: "No" },
      ]),
    ).rejects.toMatchObject({ code: "branch_not_found" });
  });
});

describe("DocsContentService expected revision", () => {
  let env: ReturnType<typeof fixture>;
  beforeEach(() => {
    env = fixture();
  });

  const edit = (content: string) =>
    [{ type: "set_page_content", href: "/", content }] as const;

  async function createNamedBranch(): Promise<string> {
    const result = await env.branches.createNamedBranch({
      userId,
      projectId,
      request: createDocsBranchInputSchema.parse({
        name: "agent-work",
        from: { kind: "main" },
      }),
      createdBy: { kind: "user" },
      maxBranches: 10,
    });
    if (result.status !== "created") throw new Error(result.status);
    return result.record.branch.id;
  }

  test("writes when the named branch is at the expected revision", async () => {
    const branchId = await createNamedBranch();
    const first = await env.service.applyEdits(
      actor,
      projectId,
      edit("# One"),
      branchId,
      { expectedRevision: 0 },
    );
    const second = await env.service.applyEdits(
      actor,
      projectId,
      edit("# Two"),
      branchId,
      { expectedRevision: first.revision },
    );
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    const page = await env.service.getPage(actor, projectId, "/", branchId);
    expect(page.workingContent).toBe("# Two");
  });

  test("a stale revision fails with the current revision and writes nothing", async () => {
    const branchId = await createNamedBranch();
    await env.service.applyEdits(actor, projectId, edit("# One"), branchId);
    const write = vi.spyOn(env.branches, "writeChanges");

    await expect(
      env.service.applyEdits(actor, projectId, edit("# Stale"), branchId, {
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { currentRevision: 1 },
    });
    expect(write).not.toHaveBeenCalled();
    const page = await env.service.getPage(actor, projectId, "/", branchId);
    expect(page.workingContent).toBe("# One");
  });

  test("a write that loses a race fails with the latest revision and is not retried", async () => {
    const branchId = await createNamedBranch();
    const original = env.branches.writeChanges.bind(env.branches);
    const write = vi
      .spyOn(env.branches, "writeChanges")
      .mockImplementationOnce(async (input) => {
        await original({ ...input, changes: [] });
        return original(input);
      });

    await expect(
      env.service.applyEdits(actor, projectId, edit("# Late"), branchId, {
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { currentRevision: 1 },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("main without a hidden branch is at revision 0", async () => {
    const working = await env.service.applyEdits(
      actor,
      projectId,
      edit("# Edited"),
      "main",
      { expectedRevision: 0 },
    );
    expect(working.revision).toBe(1);
  });

  test("main without a hidden branch rejects another revision and creates no branch", async () => {
    await expect(
      env.service.applyEdits(actor, projectId, edit("# Edited"), "main", {
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { currentRevision: 0 },
    });
    expect(
      await env.branches.getBranchForUser({
        userId,
        projectId,
        branch: "main",
      }),
    ).toBeNull();
  });

  test("without an expected revision a lost race is retried", async () => {
    const branchId = await createNamedBranch();
    const original = env.branches.writeChanges.bind(env.branches);
    vi.spyOn(env.branches, "writeChanges").mockImplementationOnce(
      async (input) => {
        await original({ ...input, changes: [] });
        return original(input);
      },
    );

    const working = await env.service.applyEdits(
      actor,
      projectId,
      edit("# Retried"),
      branchId,
    );
    expect(working.revision).toBe(2);
  });
});
