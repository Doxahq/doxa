import { describe, expect, test } from "vitest";
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
          { href: "/faq", title: "FAQ", sourcePath: "source/faq/index.mdx" },
        ],
      }),
    ],
    [`${prefix}/source/index.mdx`, "---\ntitle: Home\n---\n\n# Home\n"],
    [`${prefix}/source/guide/index.mdx`, "---\ntitle: Guide\n---\n\n# Guide\n"],
    [`${prefix}/source/faq/index.mdx`, "---\ntitle: FAQ\n---\n\n# FAQ\n"],
    [
      `${prefix}/settings/sections.json`,
      JSON.stringify([{ slug: "default", label: "Docs", default: true }]),
    ],
    [
      `${prefix}/settings/documents.json`,
      JSON.stringify([
        { title: "Home", href: "/" },
        { title: "Guide", href: "/guide" },
        { title: "FAQ", href: "/faq" },
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
  const homePage = async () =>
    (await service.getOverview(actor, projectId)).siteConfig.working?.homePage;
  return { service, homePage };
}

describe("setting the home page", () => {
  test("stores the chosen page in the working site config", async () => {
    const { service, homePage } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_home_page", href: "/guide/" },
    ]);
    expect(await homePage()).toBe("/guide");
  });

  test("keeps the other site settings of the branch", async () => {
    const { service } = fixture();
    const published = (await service.getOverview(actor, projectId)).siteConfig.published;
    await service.applyEdits(actor, projectId, [
      { type: "set_site_config", config: { ...published, description: "Edited" } },
      { type: "set_home_page", href: "/guide" },
    ]);
    const working = (await service.getOverview(actor, projectId)).siteConfig.working;
    expect(working).toMatchObject({ description: "Edited", homePage: "/guide" });
  });

  test("null removes the choice", async () => {
    const { service, homePage } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_home_page", href: "/guide" },
    ]);
    await service.applyEdits(actor, projectId, [
      { type: "set_home_page", href: null },
    ]);
    expect(await homePage()).toBeUndefined();
  });

  test("an unknown page is refused", async () => {
    const { service } = fixture();
    await expect(
      service.applyEdits(actor, projectId, [
        { type: "set_home_page", href: "/missing" },
      ]),
    ).rejects.toThrow(/No page exists/);
  });
});

describe("the home page across structure edits", () => {
  test("stays the same page when pages are reordered", async () => {
    const { service, homePage } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_home_page", href: "/guide" },
      {
        type: "move_page",
        href: "/faq",
        toSectionSlug: "default",
        toGroupIndex: null,
        beforeHref: "/",
      },
    ]);
    expect(await homePage()).toBe("/guide");
  });

  test("follows a rename of the home page", async () => {
    const { service, homePage } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_home_page", href: "/guide" },
    ]);
    await service.applyEdits(actor, projectId, [
      { type: "rename_page", href: "/guide", title: "Guide", slug: "setup" },
    ]);
    expect(await homePage()).toBe("/setup");
  });

  test("is removed with a deleted home page, so the root shows the first page", async () => {
    const { service, homePage } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_home_page", href: "/guide" },
    ]);
    await service.applyEdits(actor, projectId, [
      { type: "delete_page", href: "/guide" },
    ]);
    expect(await homePage()).toBeUndefined();
  });

  test("does not change when another page is deleted", async () => {
    const { service, homePage } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "set_home_page", href: "/guide" },
    ]);
    await service.applyEdits(actor, projectId, [
      { type: "delete_page", href: "/faq" },
    ]);
    expect(await homePage()).toBe("/guide");
  });

  test("leaves the site config alone when no home page is set", async () => {
    const { service } = fixture();
    await service.applyEdits(actor, projectId, [
      { type: "delete_page", href: "/faq" },
    ]);
    expect((await service.getOverview(actor, projectId)).siteConfig.working).toBeNull();
  });
});

describe("the home page edit contract", () => {
  test("accepts an href or null", () => {
    expect(docsContentEditSchema.safeParse({ type: "set_home_page", href: "/guide" }).success).toBe(true);
    expect(docsContentEditSchema.safeParse({ type: "set_home_page", href: null }).success).toBe(true);
    expect(docsContentEditSchema.safeParse({ type: "set_home_page", href: "" }).success).toBe(false);
  });
});
