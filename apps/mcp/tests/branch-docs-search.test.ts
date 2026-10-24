import { describe, expect, test } from "vitest";
import {
  createRuntimeSearchArtifact,
  searchIndexPathForPrefix,
} from "@doxahq/docs-engine";
import type { SearchEngine } from "@doxahq/docs-search";
import { scanBranchPages } from "../src/services/branch-search-scan";
import { DocsSearch } from "../src/services/docs-search";
import {
  BASE_PAGES,
  BASE_PREFIX,
  createBranchContentFixture,
  sourcePathOf,
  toStoredChange,
  type BranchChangeSpec,
} from "@doxahq/api/tests/support/branch-content-fixture";

function subject(changes: BranchChangeSpec[] = []) {
  const fixture = createBranchContentFixture();
  const artifact = createRuntimeSearchArtifact({
    contentVersion: "base",
    pages: BASE_PAGES.map((page) => ({
      title: page.title,
      route: page.href,
      content: page.source,
    })),
  });
  fixture.objects.set(searchIndexPathForPrefix(BASE_PREFIX), JSON.stringify(artifact));
  fixture.setChanges(changes);
  // Fresh caches, so no test reads an engine that another test built.
  const search = new DocsSearch(
    fixture.branches,
    fixture.store,
    new Map<string, SearchEngine>(),
    new Map(),
  );
  const run = (query: string, branch?: string) =>
    search.search({
      userId: fixture.scope.userId,
      projectId: fixture.scope.projectId,
      query,
      limit: 8,
      ...(branch ? { branch } : {}),
    });
  return { ...fixture, run };
}

const EDITED_INSTALL = "---\ntitle: Install\n---\n\n# Install\n\nRun the bootstrap command.\n";

describe("search_docs on a branch", () => {
  test("marks every live result published without a branch", async () => {
    const { run } = subject([{ path: sourcePathOf("/install"), content: EDITED_INSTALL }]);

    const outcome = await run("setup script");

    expect(outcome.truncated).toBeNull();
    expect(outcome.results.map(({ slug, status }) => ({ slug, status }))).toEqual([
      { slug: "/install", status: "published" },
    ]);
  });

  test("searches the branch text of a changed page and marks it edited", async () => {
    const { run, scope } = subject([
      { path: sourcePathOf("/install"), content: EDITED_INSTALL },
    ]);

    const edited = await run("bootstrap", scope.branch);
    const stale = await run("setup script", scope.branch);
    const unchanged = await run("welcome", scope.branch);

    expect(edited.results.map(({ slug, status }) => ({ slug, status }))).toEqual([
      { slug: "/install", status: "edited" },
    ]);
    expect(stale.results).toEqual([]);
    expect(unchanged.results.map(({ slug, status }) => ({ slug, status }))).toEqual([
      { slug: "/", status: "published" },
    ]);
  });

  test("finds a page that only the branch has", async () => {
    const { run, scope } = subject([
      {
        path: sourcePathOf("/rate-limits"),
        content: "---\ntitle: Rate limits\n---\n\n# Rate limits\n\nRequests are throttled.\n",
      },
    ]);

    const outcome = await run("throttled", scope.branch);

    expect(outcome.results).toEqual([
      expect.objectContaining({ slug: "/rate-limits", title: "Rate limits", status: "edited" }),
    ]);
  });

  test("leaves out a page that the branch deleted", async () => {
    const { run, scope } = subject([{ path: sourcePathOf("/legacy"), content: null }]);

    expect((await run("billing")).results).toHaveLength(1);
    expect((await run("billing", scope.branch)).results).toEqual([]);
  });

  test("says when the scan stopped at the size limit and hides the unscanned page", async () => {
    const huge = `---\ntitle: Install\n---\n\n# Install\n\n${"bootstrap ".repeat(220_000)}\n`;
    const { run, scope } = subject([{ path: sourcePathOf("/install"), content: huge }]);

    const outcome = await run("setup script", scope.branch);

    expect(outcome.truncated).toBe("size_limit");
    expect(outcome.results).toEqual([]);
  });

  test("answers branch_not_found for a branch of another user", async () => {
    const { store, branches, scope } = subject();
    const search = new DocsSearch(branches, store, new Map(), new Map());

    await expect(
      search.search({
        userId: "someone-else",
        projectId: scope.projectId,
        query: "install",
        limit: 8,
        branch: scope.branch,
      }),
    ).rejects.toMatchObject({ code: "branch_not_found" });
  });
});

describe("branch scan limits", () => {
  const change = (path: string, content: string | null) =>
    toStoredChange({ path, content });

  test("stops at the page limit; later pages stay hidden from the live index", () => {
    const scan = scanBranchPages(
      [
        change("source/a/index.mdx", "a"),
        change("source/b/index.mdx", "b"),
        change("source/c/index.mdx", "c"),
        change("source/d/index.mdx", null),
        change("settings/site.json", "{}"),
      ],
      { maxPages: 2, maxBytes: 1_000 },
    );

    expect(scan.stop).toBe("page_limit");
    expect(scan.pages.map((page) => page.href)).toEqual(["/a", "/b"]);
    expect([...scan.hiddenHrefs].sort()).toEqual(["/c", "/d"]);
  });

  test("stops at the byte limit", () => {
    const scan = scanBranchPages(
      [change("source/a/index.mdx", "1234"), change("source/b/index.mdx", "5678")],
      { maxPages: 10, maxBytes: 6 },
    );

    expect(scan.stop).toBe("size_limit");
    expect(scan.pages.map((page) => page.href)).toEqual(["/a"]);
    expect([...scan.hiddenHrefs]).toEqual(["/b"]);
  });
});
