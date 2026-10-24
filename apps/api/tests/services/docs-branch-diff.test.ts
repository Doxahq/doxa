import { describe, expect, test } from "vitest";
import { DOCS_BRANCH_DIFF_MAX_LINES } from "@doxahq/contracts/docs-branches";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { DocsBranchDiffService } from "../../src/services/docs-branches/branch-diff";
import { cappedUnifiedDiff } from "../../src/services/docs-branches/unified-diff";
import {
  BASE_PAGES,
  BASE_PREFIX,
  BASE_VERSION_ID,
  createBranchContentFixture,
  NEXT_VERSION_ID,
  SITE_ID,
  sourcePathOf,
} from "../support/branch-content-fixture";

function subject() {
  const fixture = createBranchContentFixture();
  const service = new DocsBranchDiffService(fixture.branches, fixture.store);
  return { ...fixture, service };
}

describe("branch diff", () => {
  test("lists added, edited and deleted pages with titles and unified diffs", async () => {
    const { service, scope, setChanges, manifestWith } = subject();
    setChanges([
      {
        path: sourcePathOf("/install"),
        content: "---\ntitle: Install Doxa\n---\n\n# Install\n\nRun the new setup script.\n",
      },
      {
        path: sourcePathOf("/rate-limits"),
        content: "---\ntitle: Rate limits\n---\n\n# Rate limits\n",
      },
      { path: sourcePathOf("/legacy"), content: null },
      {
        path: "manifest.json",
        content: manifestWith([
          { href: "/", title: "Home" },
          { href: "/install", title: "Install" },
          { href: "/rate-limits", title: "Rate limits" },
        ]),
      },
    ]);

    const diff = await service.diff(scope);

    expect(diff).toMatchObject({
      baseVersionId: BASE_VERSION_ID,
      mainVersionId: BASE_VERSION_ID,
      behind: false,
      siteSettings: null,
    });
    expect(diff.pages.map(({ href, title, change }) => ({ href, title, change }))).toEqual([
      { href: "/install", title: "Install Doxa", change: "edited" },
      { href: "/legacy", title: "Legacy", change: "deleted" },
      { href: "/rate-limits", title: "Rate limits", change: "added" },
    ]);
    const edited = diff.pages[0];
    expect(edited?.diff).toContain("--- a/source/install/index.mdx");
    expect(edited?.diff).toContain("-Run the setup script.");
    expect(edited?.diff).toContain("+Run the new setup script.");
    expect(edited?.truncated).toBe(false);
    expect(diff.pages[1]?.diff).toContain("+++ /dev/null");
    expect(diff.pages[2]?.diff).toContain("--- /dev/null");
  });

  test("reports navigation and site settings changes as formatted JSON diffs", async () => {
    const { service, scope, setChanges } = subject();
    setChanges([
      {
        path: "settings/documents.json",
        content: JSON.stringify([
          { href: "/", title: "Home" },
          { href: "/install", title: "Installation" },
          { href: "/legacy", title: "Legacy" },
        ]),
      },
      { path: "settings/site.json", content: JSON.stringify({ name: "Example Docs" }) },
    ]);

    const diff = await service.diff(scope);

    expect(diff.pages).toEqual([]);
    expect(diff.structure).toEqual([
      expect.objectContaining({
        path: "settings/documents.json",
        label: "Navigation",
        change: "edited",
      }),
    ]);
    expect(diff.structure[0]?.diff).toContain('+    "title": "Installation"');
    expect(diff.siteSettings).toMatchObject({ change: "edited", truncated: false });
    expect(diff.siteSettings?.diff).toContain('+  "name": "Example Docs"');
  });

  test("leaves out a change row that matches the base", async () => {
    const { service, scope, setChanges } = subject();
    const home = BASE_PAGES[0];
    setChanges([{ path: sourcePathOf(home.href), content: home.source }]);

    const diff = await service.diff(scope);

    expect(diff.pages).toEqual([]);
  });

  test("says when main moved on since the branch base", async () => {
    const { service, scope, branches, objects } = subject();
    const nextPrefix = buildArtifactPrefix(SITE_ID, NEXT_VERSION_ID);
    const baseManifest = objects.get(`${BASE_PREFIX}/manifest.json`) ?? "";
    objects.set(`${nextPrefix}/manifest.json`, baseManifest);
    branches.setMainVersion(SITE_ID, NEXT_VERSION_ID, nextPrefix, 2);

    const diff = await service.diff(scope);

    expect(diff).toMatchObject({
      baseVersionId: BASE_VERSION_ID,
      mainVersionId: NEXT_VERSION_ID,
      behind: true,
    });
  });

  test("returns both sources of one changed page", async () => {
    const { service, scope, setChanges } = subject();
    setChanges([{ path: sourcePathOf("/legacy"), content: null }]);

    await expect(service.pageSources({ ...scope, href: "/legacy" })).resolves.toEqual({
      href: "/legacy",
      title: "Legacy",
      change: "deleted",
      before: BASE_PAGES[2].source,
      after: null,
    });
    await expect(
      service.pageSources({ ...scope, href: "/install" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("answers branch_not_found for a branch the user does not own", async () => {
    const { service, scope } = subject();

    await expect(
      service.diff({ ...scope, userId: "someone-else" }),
    ).rejects.toMatchObject({ code: "branch_not_found" });
  });
});

describe("capped unified diff", () => {
  test(`cuts a diff after ${DOCS_BRANCH_DIFF_MAX_LINES} lines and says so`, () => {
    const after = Array.from({ length: 400 }, (_, index) => `line ${index}\n`).join("");

    const result = cappedUnifiedDiff({ path: "source/index.mdx", before: null, after });

    expect(result.truncated).toBe(true);
    expect(result.lineCount).toBe(403);
    expect(result.diff.trimEnd().split("\n")).toHaveLength(DOCS_BRANCH_DIFF_MAX_LINES);
  });

  test("keeps a short diff whole", () => {
    const result = cappedUnifiedDiff({
      path: "source/index.mdx",
      before: "a\nb\n",
      after: "a\nc\n",
    });

    expect(result).toEqual({
      diff: "--- a/source/index.mdx\n+++ b/source/index.mdx\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n",
      lineCount: 6,
      truncated: false,
    });
  });
});
