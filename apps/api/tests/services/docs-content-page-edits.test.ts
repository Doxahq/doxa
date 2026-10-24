import { describe, expect, test, vi } from "vitest";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { siteIdSchema, versionIdSchema } from "@doxahq/contracts/docs-branches";
import { docsContentEditSchema } from "@doxahq/contracts";
import { InMemoryDocsBranchStore } from "../support/in-memory-docs-branches";
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
        pages: [
          { href: "/", title: "Home", sourcePath: "source/index.mdx" },
          { href: "/guide", title: "Guide", sourcePath: "source/guide/index.mdx" },
        ],
      }),
    ],
    [`${prefix}/source/index.mdx`, "---\ntitle: Home\n---\n\n# Home\n"],
    [`${prefix}/source/guide/index.mdx`, "---\ntitle: Guide\n---\n\n# Guide\n"],
    [
      `${prefix}/settings/sections.json`,
      JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
    ],
    [
      `${prefix}/settings/documents.json`,
      JSON.stringify([
        { title: "Home", href: "/" },
        { title: "Guide", href: "/guide" },
      ]),
    ],
  ]);
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
    store: createInMemoryDocsContentStore(objects),
    branches,
    entitlements: freePlanEntitlements,
    assets: { head: async () => null },
  });
  return { service, objects, branches };
}

describe("renaming a page twice before a publish", () => {
  test("the second rename moves the page again", async () => {
    const { service } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "rename_page", href: "/guide", title: "Guide", slug: "setup" },
    ]);
    await service.applyEdits(actor, projectId, [
      { type: "rename_page", href: "/setup", title: "Guide", slug: "install" },
    ]);
    const overview = await service.getOverview(actor, projectId);
    expect(overview.pages.map((page) => page.href)).toEqual(["/", "/install"]);
    expect((await service.getPage(actor, projectId, "/install")).workingContent).toContain("# Guide");
  });

  test("renaming back to the published slug restores the page", async () => {
    const { service } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "rename_page", href: "/guide", title: "Guide", slug: "setup" },
    ]);
    await service.applyEdits(actor, projectId, [
      { type: "rename_page", href: "/setup", title: "Guide", slug: "guide" },
    ]);
    const overview = await service.getOverview(actor, projectId);
    expect(overview.pages.map((page) => page.href)).toEqual(["/", "/guide"]);
  });
});

describe("reporting page moves to the branch", () => {
  test("names each renamed page once, from its first href to its last", async () => {
    const { service, branches } = fixture();
    const write = vi.spyOn(branches, "writeChanges");

    await service.applyEdits(actor, projectId, [
      { type: "rename_page", href: "/guide", title: "Guide", slug: "setup" },
      { type: "rename_page", href: "/setup", title: "Guide", slug: "install" },
    ]);

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ hrefMoves: [{ from: "/guide", to: "/install" }] }),
    );
  });

  test("reports no move for a page that a save renames back", async () => {
    const { service, branches } = fixture();
    const write = vi.spyOn(branches, "writeChanges");

    await service.applyEdits(actor, projectId, [
      { type: "rename_page", href: "/guide", title: "Guide", slug: "setup" },
      { type: "rename_page", href: "/setup", title: "Guide", slug: "guide" },
      { type: "set_page_icon", href: "/guide", icon: "rocket" },
    ]);

    expect(write).toHaveBeenCalledWith(expect.objectContaining({ hrefMoves: [] }));
  });
});

describe("setting a page icon", () => {
  test("writes the icon to the navigation entry and the overview reads it back", async () => {
    const { service } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_page_icon", href: "/guide", icon: "rocket" },
    ]);
    const overview = await service.getOverview(actor, projectId);
    expect(overview.pages.find((page) => page.href === "/guide")?.icon).toBe("rocket");
    expect(overview.pages.find((page) => page.href === "/")?.icon).toBeNull();
  });

  test("null removes the icon", async () => {
    const { service } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_page_icon", href: "/guide", icon: "rocket" },
    ]);
    await service.applyEdits(actor, projectId, [
      { type: "set_page_icon", href: "/guide", icon: null },
    ]);
    const overview = await service.getOverview(actor, projectId);
    expect(overview.pages.find((page) => page.href === "/guide")?.icon).toBeNull();
  });

  test("the icon follows a rename", async () => {
    const { service } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_page_icon", href: "/guide", icon: "rocket" },
    ]);
    await service.applyEdits(actor, projectId, [
      { type: "rename_page", href: "/guide", title: "Guide", slug: "setup" },
    ]);
    const overview = await service.getOverview(actor, projectId);
    expect(overview.pages.find((page) => page.href === "/setup")?.icon).toBe("rocket");
  });

  test("an unknown page is refused", async () => {
    const { service } = fixture();
    await expect(
      service.applyEdits(actor, projectId, [
        { type: "set_page_icon", href: "/missing", icon: "rocket" },
      ]),
    ).rejects.toThrow(/No page exists/);
  });
});

describe("the page icon edit contract", () => {
  test.each(["rocket", "bookOpen", "circleHelp"])("accepts %s", (icon) => {
    expect(docsContentEditSchema.safeParse({ type: "set_page_icon", href: "/guide", icon }).success).toBe(true);
  });

  test("accepts null to remove the icon", () => {
    expect(docsContentEditSchema.safeParse({ type: "set_page_icon", href: "/guide", icon: null }).success).toBe(true);
  });

  test.each(["", "Rocket", "rocket-ship", "<svg>", "a".repeat(41)])("refuses %j", (icon) => {
    expect(docsContentEditSchema.safeParse({ type: "set_page_icon", href: "/guide", icon }).success).toBe(false);
  });
});
