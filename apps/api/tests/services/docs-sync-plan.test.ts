import { describe, expect, test } from "vitest";
import {
  applyResolutions,
  computeSyncPlan,
  type ComparedChange,
} from "../../src/services/docs-branches/sync-plan";

function page(
  base: string | null,
  main: string | null,
  mine: string | null,
): ComparedChange {
  return { path: "source/index.mdx", base, main, mine };
}

describe("branch synchronization plan", () => {
  test.each([
    ["unchanged main", page("a", "a", "b"), "keep_change"],
    ["main already has mine", page("a", "b", "b"), "drop_change"],
    ["both changed differently", page("a", "b", "c"), "conflict"],
    ["both deleted", page("a", null, null), "drop_change"],
    ["mine adds a page", page(null, null, "b"), "keep_change"],
    ["both add the same page", page(null, "b", "b"), "drop_change"],
    ["both add different pages", page(null, "b", "c"), "conflict"],
  ] as const)("%s", (_, change, expected) => {
    const plan = computeSyncPlan({
      changes: [change],
      mainChangedStructurePaths: new Set(),
    });
    expect(plan.decisions.get(change.path)).toBe(expected);
    expect(plan.conflicts).toHaveLength(expected === "conflict" ? 1 : 0);
  });

  test("structure conflicts when main changed a different structure file", () => {
    const change = {
      path: "settings/documents.json",
      base: "[]",
      main: "[]",
      mine: "[1]",
    };
    const plan = computeSyncPlan({
      changes: [change],
      mainChangedStructurePaths: new Set(["manifest.json"]),
    });
    expect(plan.conflicts).toEqual([{ unit: "structure", key: "structure" }]);
    expect(plan.decisions.get(change.path)).toBe("conflict");
  });

  test("structure match drops the row when main has the same content", () => {
    const change = {
      path: "settings/documents.json",
      base: "[]",
      main: "[1]",
      mine: "[1]",
    };
    const plan = computeSyncPlan({
      changes: [change],
      mainChangedStructurePaths: new Set([change.path]),
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.decisions.get(change.path)).toBe("drop_change");
  });

  test("structure resolution pins every path for mine and clears every row for main", () => {
    const changes = [
      { path: "settings/documents.json", base: "[]", main: "[]", mine: "[1]" },
    ];
    const plan = computeSyncPlan({
      changes,
      mainChangedStructurePaths: new Set(["manifest.json"]),
    });
    const structureContents = new Map<string, string | null>([
      ["manifest.json", "old manifest"],
      ["settings/documents.json", "[1]"],
      ["settings/sections.json", "old sections"],
    ]);
    const mine = applyResolutions({
      plan,
      changes,
      structureContents,
      request: { resolutions: [{ key: "structure", resolution: "mine" }] },
    });
    expect(mine.desired).toEqual(structureContents);
    const main = applyResolutions({
      plan,
      changes,
      structureContents,
      request: { resolutions: [], defaultResolution: "main" },
    });
    expect([...main.desired.values()]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("keeps a page that the branch deleted when main wins the structure", () => {
    // The branch removed /guide: a structure edit plus a delete row for the
    // source. Main still lists /guide, so its source must stay.
    const changes: ComparedChange[] = [
      { path: "manifest.json", base: "m0", main: "m1", mine: "m2" },
      { path: "source/guide/index.mdx", base: "g", main: "g", mine: null },
    ];
    const plan = computeSyncPlan({
      changes,
      mainChangedStructurePaths: new Set(["manifest.json"]),
    });
    const result = applyResolutions({
      plan,
      changes,
      structureContents: new Map([["manifest.json", "m2"]]),
      request: { resolutions: [{ key: "structure", resolution: "main" }] },
    });

    expect(result.structureResolution).toBe("main");
    expect(result.desired.has("source/guide/index.mdx")).toBe(true);
    expect(result.desired.get("source/guide/index.mdx")).toBeUndefined();
  });

  test("keeps the page deletion when the branch wins the structure", () => {
    const changes: ComparedChange[] = [
      { path: "manifest.json", base: "m0", main: "m1", mine: "m2" },
      { path: "source/guide/index.mdx", base: "g", main: "g", mine: null },
    ];
    const plan = computeSyncPlan({
      changes,
      mainChangedStructurePaths: new Set(["manifest.json"]),
    });
    const result = applyResolutions({
      plan,
      changes,
      structureContents: new Map([["manifest.json", "m2"]]),
      request: { resolutions: [{ key: "structure", resolution: "mine" }] },
    });

    expect(result.structureResolution).toBe("mine");
    expect(result.desired.get("source/guide/index.mdx")).toBeNull();
  });

  test("explicit resolution wins over the bulk default", () => {
    const changes = [
      page("a", "b", "c"),
      {
        path: "settings/site.json",
        base: "a",
        main: "b",
        mine: "c",
      },
    ];
    const plan = computeSyncPlan({
      changes,
      mainChangedStructurePaths: new Set(),
    });
    const result = applyResolutions({
      plan,
      changes,
      structureContents: new Map(),
      request: {
        defaultResolution: "main",
        resolutions: [{ key: "page:/", resolution: "mine" }],
      },
    });
    expect(result.unresolved).toEqual([]);
    expect(result.desired.get("source/index.mdx")).toBe("c");
    expect(result.desired.get("settings/site.json")).toBeUndefined();
  });

  test("main-only structure change cannot conflict without a branch structure change", () => {
    const plan = computeSyncPlan({
      changes: [page("a", "a", "b")],
      mainChangedStructurePaths: new Set(["manifest.json"]),
    });
    expect(plan.conflicts).toEqual([]);
  });
});
