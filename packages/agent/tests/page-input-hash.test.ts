import { describe, expect, test } from "vitest";

import type { DocumentationStructure } from "../src";
import { deterministicPageRendererFor } from "../src/doxa-agent/deterministic-pages";
import { baselinePageInputHashes, buildPageInputHashMap } from "../src/doxa-agent/generation-service";
import { flattenStructure, stablePageId } from "../src/doxa-agent/structure-utils";
import { hashPageInputs, legacyPageInputFields } from "../src/state/page-input-hash";
import { buildStructureHash } from "../src/state/planning";
import { hashJson } from "../src/utils/stable-hash";
import { hashObject } from "../src/utils/hash";

function structure(
  evidence: NonNullable<DocumentationStructure["sections"][number]["pages"][number]["sourceEvidence"]>,
  description = "Compare a context attribute with one exact value using the equals operator.",
): DocumentationStructure {
  return {
    sections: [{
      id: "default",
      title: "Documentation",
      default: true,
      pages: [{ id: "equals", title: "equals", description, sourceEvidence: evidence }],
    }],
  };
}

/** The rule that stored baselines before 2026-10-17, frozen here as history. */
function legacyHashes(value: DocumentationStructure): Record<string, string> {
  return Object.fromEntries(flattenStructure(value).map((target) => [
    stablePageId(target),
    hashObject({
      pageId: stablePageId(target),
      sectionTitle: target.sectionTitle,
      title: target.page.title,
      description: target.page.description,
      outputPath: target.path,
      group: target.page.group,
      sourceEvidence: target.page.sourceEvidence ?? [],
      collectionId: target.page.collectionId,
      collectionItemId: target.page.collectionItemId,
      reference: target.page.reference,
      renderer: deterministicPageRendererFor(target.page)?.id,
    }),
  ]));
}

const annotated = structure([
  { path: "packages/core/src/types.ts", kind: "source", title: "Operator type" },
  { path: "docs/operators.md", kind: "docs" },
]);

describe("page input hash", () => {
  test("counts evidence by its files and a description by its words", () => {
    const relabelled = structure(
      [{ path: "docs/operators.md" }, { path: "packages/core/src/types.ts" }, { path: "docs/operators.md" }],
      "  Compare a context attribute\nwith one exact value   using the equals operator. ",
    );

    expect(buildPageInputHashMap(relabelled)).toEqual(buildPageInputHashMap(annotated));
  });

  test("still changes when the files or the words change", () => {
    const otherFile = structure([{ path: "packages/core/src/evaluate.ts" }, { path: "docs/operators.md" }]);
    const otherWords = structure(
      [{ path: "packages/core/src/types.ts" }, { path: "docs/operators.md" }],
      "Compare a context attribute with a list of values using the in operator.",
    );

    expect(buildPageInputHashMap(otherFile)).not.toEqual(buildPageInputHashMap(annotated));
    expect(buildPageInputHashMap(otherWords)).not.toEqual(buildPageInputHashMap(annotated));
  });

  test("reads a baseline stored with the earlier rule as the current rule", () => {
    const stored = legacyHashes(annotated);
    expect(stored).not.toEqual(buildPageInputHashMap(annotated));

    expect(baselinePageInputHashes(annotated, stored)).toEqual(buildPageInputHashMap(annotated));
  });

  test("keeps a stored hash that its structure does not explain", () => {
    const stored = { "default/equals": "f".repeat(64), "default/gone": "e".repeat(64) };

    expect(baselinePageInputHashes(annotated, stored)).toEqual(stored);
  });

  test("hashes the same in a Worker as in the generation service", async () => {
    const rest: DocumentationStructure = {
      sections: [{
        id: "rest-api",
        title: "REST API",
        pages: [{ id: "get-flag", title: "Get a flag", description: "Read one flag.", reference: { kind: "rest", endpointId: "get-flag" } }],
      }],
    };

    for (const value of [annotated, rest]) {
      expect(await hashPageInputs(value)).toEqual(buildPageInputHashMap(value));
      expect(await hashPageInputs(value, legacyPageInputFields)).toEqual(legacyHashes(value));
      expect(await hashJson(value)).toBe(await buildStructureHash(value));
    }
  });
});
