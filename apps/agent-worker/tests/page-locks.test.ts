import {
  GENERATION_STATE_SCHEMA_VERSION,
  incrementalGenerationPlanSchema,
  type GenerationPageState,
  type IncrementalGenerationPlan,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

import {
  applyPageLocks,
  changedSourcePaths,
  lockedHrefsOf,
  lockedPageFlagsOf,
} from "../src/page-locks";

const hash = "a".repeat(64);

function statePage(pageId: string, route: string, reads: string[]): GenerationPageState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    pageId,
    title: pageId,
    route,
    navigationPath: `default/${pageId}.md`,
    artifactKey: `sites/site-1/versions/version-1/source${route}/index.mdx`,
    contentHash: hash,
    pageInputHash: hash,
    dependencies: {
      sourceFilesRead: reads,
      sourceFilesDiscovered: [],
      sourceEvidenceFiles: [],
      referencedSymbols: [],
      referencedRoutes: [],
    },
  };
}

const statePages = [
  statePage("auth", "/auth", ["src/auth.ts"]),
  statePage("billing", "/billing", ["src/billing.ts"]),
  statePage("faq", "/faq", []),
];

function plan(regenerate: string[], reuse: string[]): IncrementalGenerationPlan {
  return incrementalGenerationPlanSchema.parse({
    analysisMode: "incremental",
    structureMode: "reuse",
    regeneratePageIds: regenerate,
    reusePageIds: reuse,
    removedPageIds: [],
    modelCallsRequired: regenerate.length > 0,
    reasons: ["Page auth depends on changed source."],
    causes: { newPages: 0, inputChanged: 0, dependencyChanged: regenerate.length },
  });
}

describe("applyPageLocks", () => {
  test("keeps a locked page and flags the sources that changed under it", () => {
    const result = applyPageLocks({
      plan: plan(["auth", "billing"], ["faq"]),
      statePages,
      lockedHrefs: lockedHrefsOf({ pageLocks: { locked: ["/auth"] } }),
      changedPaths: new Set(["src/auth.ts", "src/billing.ts"]),
    });

    expect(result.regeneratePageIds).toEqual(["billing"]);
    expect(result.reusePageIds).toEqual(["faq", "auth"]);
    expect(result.ownedPageFlags).toEqual([
      { pageId: "auth", changedPaths: ["src/auth.ts"] },
    ]);
    expect(result.causes).toBeUndefined();
    expect(incrementalGenerationPlanSchema.safeParse(result).success).toBe(true);
  });

  test("drops the page edit of a page that it keeps", () => {
    const result = applyPageLocks({
      plan: incrementalGenerationPlanSchema.parse({
        ...plan(["auth", "billing"], []),
        pageEdits: {
          auth: { artifactKey: "v1/auth.mdx", changedSources: ["src/auth.ts"] },
          billing: { artifactKey: "v1/billing.mdx", changedSources: ["src/billing.ts"] },
        },
      }),
      statePages,
      lockedHrefs: lockedHrefsOf({ pageLocks: { locked: ["/auth"] } }),
      changedPaths: new Set(["src/auth.ts", "src/billing.ts"]),
    });

    expect(result.pageEdits).toEqual({
      billing: { artifactKey: "v1/billing.mdx", changedSources: ["src/billing.ts"] },
    });
    expect(incrementalGenerationPlanSchema.safeParse(result).success).toBe(true);
  });

  test("leaves the plan alone when locks change nothing", () => {
    const original = plan(["billing"], ["auth"]);

    expect(
      applyPageLocks({
        plan: original,
        statePages,
        lockedHrefs: lockedHrefsOf({ pageLocks: { locked: ["/auth"] } }),
        changedPaths: new Set(),
      }),
    ).toBe(original);
  });

  test("does not flag a locked page whose own sources did not change", () => {
    const result = applyPageLocks({
      plan: plan(["auth"], []),
      statePages,
      lockedHrefs: lockedHrefsOf({ pageLocks: { locked: ["/auth/"] } }),
      changedPaths: new Set(["src/other.ts"]),
    });

    expect(result.reusePageIds).toEqual(["auth"]);
    expect(result.ownedPageFlags).toBeUndefined();
    expect(result.modelCallsRequired).toBe(false);
  });

  test("turns plan flags into review flags with route and title", () => {
    const result = applyPageLocks({
      plan: plan(["auth"], []),
      statePages,
      lockedHrefs: lockedHrefsOf({ pageLocks: { locked: ["/auth"] } }),
      changedPaths: changedSourcePaths([
        { path: "src/auth.ts", status: "modified" },
      ]),
    });

    expect(lockedPageFlagsOf(result, statePages)).toEqual([
      { href: "/auth", title: "auth", changedPaths: ["src/auth.ts"] },
    ]);
  });
});
