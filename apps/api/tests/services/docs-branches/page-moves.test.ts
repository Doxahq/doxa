import { describe, expect, test } from "vitest";
import { branchIdSchema, relativeNavigationPathForSection } from "@doxahq/contracts/docs-branches";
import { buildArtifactPrefix, sourcePathForHref } from "@doxahq/docs-engine";

import type { StoredBranchChange } from "../../../src/repositories/docs-branch-records";
import { lockChangesAfterPublication } from "../../../src/repositories/page-locks";
import { publishedPageChanges } from "../../../src/services/docs-branches/page-moves";
import {
  createInMemoryDocsContentStore,
  type InMemoryObjects,
} from "../../support/in-memory-docs-content-store";

const SITE_ID = "40000000-0000-4000-8000-000000000001";
const VERSION_ID = "40000000-0000-4000-8000-000000000002";
const BRANCH_ID = branchIdSchema.parse("40000000-0000-4000-8000-000000000003");

interface SitePage {
  title: string;
  href: string;
  body: string;
}

/** The files of a one-section site, by path inside its version. */
function siteFiles(pages: readonly SitePage[]): Map<string, string> {
  const files = new Map<string, string>();
  files.set("manifest.json", JSON.stringify({
    siteId: SITE_ID,
    versionId: VERSION_ID,
    projectSlug: "acme",
    generatedAt: "2026-10-17T00:00:00.000Z",
    pages: pages.map((page) => ({ title: page.title, href: page.href, sourcePath: sourcePathForHref(page.href) })),
  }));
  files.set("settings/sections.json", JSON.stringify([{ slug: "default", label: "Docs", default: true }]));
  files.set(relativeNavigationPathForSection("default"), JSON.stringify(pages.map(({ title, href }) => ({ title, href }))));
  for (const page of pages) files.set(sourcePathForHref(page.href), `---\ntitle: ${page.title}\n---\n\n${page.body}\n`);
  return files;
}

/** The branch changes that turn the `base` site into the `next` site. */
function changesBetween(base: Map<string, string>, next: Map<string, string>): StoredBranchChange[] {
  const common = { branchId: BRANCH_ID, updatedByUserId: "person-1", origin: "editor" as const, updatedAt: new Date() };
  const upserts = [...next].filter(([path, content]) => base.get(path) !== content).map(([path, content]): StoredBranchChange => ({
    ...common, path, kind: "upsert", content, contentSha256: "sha", byteSize: content.length,
  }));
  const deletes = [...base.keys()].filter((path) => !next.has(path)).map((path): StoredBranchChange => ({
    ...common, path, kind: "delete", content: null, contentSha256: null, byteSize: 0,
  }));
  return [...upserts, ...deletes];
}

async function pageChanges(before: readonly SitePage[], after: readonly SitePage[]) {
  const prefix = buildArtifactPrefix(SITE_ID, VERSION_ID);
  const base = siteFiles(before);
  const objects: InMemoryObjects = new Map([...base].map(([path, content]) => [`${prefix}/${path}`, content]));
  return publishedPageChanges(createInMemoryDocsContentStore(objects), {
    baseArtifactPrefix: prefix,
    changes: changesBetween(base, siteFiles(after)),
  });
}

const install = { title: "Install", href: "/install", body: "Run the installer." };
const overview = { title: "Overview01", href: "/overview02", body: "FlagForge serves feature flags." };

describe("published page changes", () => {
  test("finds a page that a person renamed and moved, by its text", async () => {
    const changes = await pageChanges([install, overview], [install, { ...overview, title: "Overview", href: "/overview" }]);

    expect(changes).toEqual({ moves: [{ from: "/overview02", to: "/overview" }], removedHrefs: [] });
  });

  test("reports a page that a person deleted", async () => {
    expect(await pageChanges([install, overview], [install])).toEqual({ moves: [], removedHrefs: ["/overview02"] });
  });

  test("reads nothing for a branch that deletes no page", async () => {
    const changes = await pageChanges([install, overview], [{ ...install, body: "Edited." }, overview]);

    expect(changes).toEqual({ moves: [], removedHrefs: [] });
  });
});

describe("locks after a publication", () => {
  test("moves a lock with its page, drops the lock of a removed page, and keeps the others", () => {
    expect(lockChangesAfterPublication({
      locked: new Set(["/overview02", "/legacy", "/install"]),
      moves: [{ from: "/overview02", to: "/overview" }, { from: "/unlocked", to: "/elsewhere" }],
      removedHrefs: ["/legacy", "/never-locked"],
    })).toEqual({ dropped: ["/overview02", "/legacy"], added: ["/overview"] });
  });
});
