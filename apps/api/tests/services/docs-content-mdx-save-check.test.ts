import { describe, expect, test, vi } from "vitest";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { docsContentMdxReportSchema } from "@doxahq/contracts";
import { siteIdSchema, versionIdSchema } from "@doxahq/contracts/docs-branches";
import type { PublishStoredBranchInput } from "../../src/repositories/docs-branch-publication";
import { DocsBranchPublish } from "../../src/services/docs-branches/publish";
import { DocsContentService } from "../../src/services/docs-content/service";
import { freePlanEntitlements } from "../../src/services/free-plan-entitlements";
import { InMemoryDocsBranchStore } from "../support/in-memory-docs-branches";
import { createInMemoryDocsContentStore } from "../support/in-memory-docs-content-store";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const siteId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const prefix = buildArtifactPrefix(siteId, versionId);
const actor = { userId, origin: "editor" } as const;
const BROKEN = "---\ntitle: Home\n---\n\n# Home\n\n<Bogus>Hi</Bogus>\n";
const FIXED = "---\ntitle: Home\n---\n\n# Home\n\n<Note>Hi</Note>\n";

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
  const branches = new InMemoryDocsBranchStore();
  branches.addSite(userId, {
    id: siteIdSchema.parse(siteId),
    projectId,
    projectName: "Example",
    projectSlug: "example",
    mainVersionId: versionIdSchema.parse(versionId),
    mainVersionNumber: 1,
    mainArtifactPrefix: prefix,
    mainCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
  });
  const service = new DocsContentService({
    store,
    branches,
    entitlements: freePlanEntitlements,
    assets: { head: async () => null },
  });
  const publish = vi.fn(async (_input: PublishStoredBranchInput) => ({
    result: {
      versionId: "66666666-6666-4666-8666-666666666666",
      versionNumber: 2,
      publicationId: "77777777-7777-4777-8777-777777777777",
      branchErased: true,
    },
    collectEntryIds: [],
    review: null,
  }));
  const publisher = new DocsBranchPublish({
    branches,
    store,
    entitlements: freePlanEntitlements,
    assets: { head: async () => null },
    publish,
    collectStorage: vi.fn(async () => {}),
    enqueueOrphanVersion: vi.fn(async () => undefined),
  });
  return { service, publisher, publish };
}

function publishMain(
  publisher: DocsBranchPublish,
  expectedRevision: number,
) {
  return publisher.publish({
    userId,
    projectId,
    branch: "main",
    request: { expectedBaseVersionId: versionId, expectedRevision, eraseBranch: true },
  });
}

describe("MDX check on dashboard saves (spec 8.1)", () => {
  test("a save with invalid MDX still writes the page", async () => {
    const { service } = fixture();

    const working = await service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: BROKEN },
    ]);

    expect(working.changeCount).toBe(1);
    expect((await service.getPage(actor, projectId, "/")).workingContent).toBe(BROKEN);
  });

  test("the branch report lists the page with the line of the issue", async () => {
    const { service } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: BROKEN },
    ]);

    const report = await service.getMdxReport(actor, projectId, "main");

    expect(docsContentMdxReportSchema.parse(report)).toEqual({
      pages: [
        {
          href: "/",
          sourcePath: "source/index.mdx",
          issues: [
            { line: 7, column: 1, message: "Unknown MDX component: Bogus" },
          ],
        },
      ],
    });
  });

  test("main without saved changes has an empty report", async () => {
    const { service } = fixture();
    await expect(service.getMdxReport(actor, projectId, "main")).resolves.toEqual({ pages: [] });
  });

  test("an unknown branch fails the report like other reads", async () => {
    const { service } = fixture();
    await expect(
      service.getMdxReport(actor, projectId, "88888888-8888-4888-8888-888888888888"),
    ).rejects.toMatchObject({ code: "branch_not_found" });
  });
});

describe("publish with MDX issues", () => {
  test("is blocked and lists the pages; nothing goes live", async () => {
    const { service, publisher, publish } = fixture();
    const working = await service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: BROKEN },
    ]);

    const rejection = publishMain(publisher, working.revision);

    await expect(rejection).rejects.toMatchObject({
      code: "mdx_invalid",
      details: {
        pages: [
          expect.objectContaining({ href: "/", sourcePath: "source/index.mdx" }),
        ],
      },
    });
    await expect(rejection).rejects.toThrow(
      "Publish blocked: 1 page has MDX issues. / (source/index.mdx line 7): Unknown MDX component: Bogus.",
    );
    expect(publish).not.toHaveBeenCalled();
  });

  test("goes through once the page is fixed", async () => {
    const { service, publisher, publish } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: BROKEN },
    ]);
    const fixed = await service.applyEdits(actor, projectId, [
      { type: "set_page_content", href: "/", content: FIXED },
    ]);

    await expect(service.getMdxReport(actor, projectId, "main")).resolves.toEqual({ pages: [] });
    await expect(publishMain(publisher, fixed.revision)).resolves.toMatchObject({ versionNumber: 2 });
    expect(publish).toHaveBeenCalledOnce();
  });
});
