import { describe, expect, it, vi } from "vitest";
import type { BranchChangeWrite } from "../../../src/repositories/docs-branches";
import { countDiffLines, describePageChanges } from "../../../src/services/docs-content/page-changes";

function upsert(path: string, content: string): BranchChangeWrite {
  return { path, kind: "upsert", content, contentSha256: "hash", byteSize: content.length };
}

const reader = (files: Record<string, string>) => ({ read: async (path: string) => files[path] ?? null });

describe("countDiffLines", () => {
  it("skips the file headers and counts a line that starts with plus or minus", () => {
    const diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n--dash\n+new\n++plus\n+++triple\n same\n";
    expect(countDiffLines(diff)).toEqual({ linesAdded: 3, linesRemoved: 2 });
  });

  it("gives zero without a hunk", () => {
    expect(countDiffLines("--- a/x\n+++ b/x\n")).toEqual({ linesAdded: 0, linesRemoved: 0 });
  });
});

describe("describePageChanges", () => {
  it("describes an edit, a new page, and a deleted page", async () => {
    const changes = await describePageChanges(reader({ "source/a/index.mdx": "one\n", "source/b/index.mdx": "gone\n" }), [
      upsert("source/a/index.mdx", "two\n"),
      upsert("source/new/index.mdx", "fresh\n"),
      { path: "source/b/index.mdx", kind: "delete" },
    ]);
    expect(changes.map(({ href, linesAdded, linesRemoved }) => ({ href, linesAdded, linesRemoved }))).toEqual([
      { href: "/a", linesAdded: 1, linesRemoved: 1 },
      { href: "/new", linesAdded: 1, linesRemoved: 0 },
      { href: "/b", linesAdded: 0, linesRemoved: 1 },
    ]);
    expect(changes[0]?.diff).toContain("+two");
  });

  it("marks a page that did not exist before", async () => {
    const changes = await describePageChanges(reader({}), [upsert("source/new/index.mdx", "fresh\n")]);
    expect(changes[0]).toMatchObject({ href: "/new", movedFrom: null, isNew: true });
  });

  it("describes a move as one change at the new href, against the old text", async () => {
    const changes = await describePageChanges(
      reader({ "source/old/index.mdx": "---\ntitle: Old\n---\nBody\n" }),
      [upsert("source/new/index.mdx", "---\ntitle: New\n---\nBody\n"), { path: "source/old/index.mdx", kind: "delete" }],
      [{ from: "/old", to: "/new" }],
    );
    expect(changes).toEqual([
      expect.objectContaining({ href: "/new", movedFrom: "/old", isNew: false, linesAdded: 1, linesRemoved: 1 }),
    ]);
  });

  it("reports a moved page with the same text, without a diff", async () => {
    const changes = await describePageChanges(
      reader({ "source/old/index.mdx": "same\n" }),
      [upsert("source/new/index.mdx", "same\n"), { path: "source/old/index.mdx", kind: "delete" }],
      [{ from: "/old", to: "/new" }],
    );
    expect(changes).toEqual([
      { href: "/new", movedFrom: "/old", isNew: false, linesAdded: 0, linesRemoved: 0, diff: null },
    ]);
  });

  it("ignores settings, resets, and unchanged pages", async () => {
    const changes = await describePageChanges(reader({ "source/a/index.mdx": "same\n" }), [
      upsert("settings/site.json", "{}"),
      { path: "source/c/index.mdx", kind: "reset" },
      upsert("source/a/index.mdx", "same\n"),
    ]);
    expect(changes).toEqual([]);
  });

  it("limits a long diff, and still counts every changed line", async () => {
    const after = Array.from({ length: 500 }, (_, index) => `line ${index} ${"x".repeat(200)}`).join("\n");
    const [change] = await describePageChanges(reader({}), [upsert("source/index.mdx", `${after}\n`)]);
    expect(change?.linesAdded).toBe(500);
    expect(change?.diff?.length).toBeLessThanOrEqual(16_000);
    expect(change?.diff?.split("\n").length).toBeLessThanOrEqual(200);
  });

  it("skips the diff of a page over the line budget, so that a save stays cheap", async () => {
    const big = Array.from({ length: 3_000 }, (_, index) => `line ${index}`).join("\n");
    const changes = await describePageChanges(reader({ "source/big/index.mdx": big }), [
      upsert("source/small/index.mdx", "small\n"),
      upsert("source/big/index.mdx", `other\n${big.split("").reverse().join("")}`),
      upsert("source/after/index.mdx", "after\n"),
    ]);
    expect(changes.map(({ href }) => href)).toEqual(["/small", "/after"]);
  });

  it("gives no changes when a read fails, because the edit is already saved", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const changes = await describePageChanges(
      { read: async () => { throw new Error("storage down"); } },
      [upsert("source/a/index.mdx", "two\n")],
    );
    expect(changes).toEqual([]);
    error.mockRestore();
  });
});
