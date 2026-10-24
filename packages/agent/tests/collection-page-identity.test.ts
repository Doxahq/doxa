import { describe, expect, test } from "vitest";

import type { DocumentationCollection, DocumentationStructure, ProjectAnalysis } from "../src";
import { validateDocumentationStructureForProfile } from "../src/doxa-agent/prompts/dynamic";
import { applyCollectionsToStructure } from "../src/utils/documentation-collections";
import { analysisFixture } from "./fixtures";

function collection(): DocumentationCollection {
  return {
    id: "condition-operators",
    title: "Condition Operators",
    kind: "mixed",
    sourceEvidence: [{ path: "src/operators.ts", kind: "source" }],
    items: [
      ["starts-with", "Starts with", "Matches when the value starts with the configured prefix."],
      ["greater-than", "Greater than", "Numeric comparison."],
      ["matches-regex", "Matches regex", "Pattern comparison."],
      ["in-segment", "In segment", "Segment membership."],
    ].map(([slug, title, description]) => ({
      id: `condition-operators/${slug}`,
      slug: slug!,
      title: title!,
      description,
      sourceEvidence: [{ path: "src/operators.ts", kind: "source" }],
    })),
  };
}

function analysis(): ProjectAnalysis {
  return { ...analysisFixture, documentationCollections: [collection()] };
}

function structure(pages: DocumentationStructure["sections"][number]["pages"]): DocumentationStructure {
  return {
    sections: [{
      id: "documentation",
      title: "Documentation",
      default: true,
      pages,
    }],
  };
}

describe("collection page identity", () => {
  test("uses canonical analysis identity for flat grouped item pages", () => {
    const enriched = applyCollectionsToStructure(structure([{
      id: "condition-operators",
      title: "Condition Operators",
      description: "Model-authored overview.",
      collectionId: "condition-operators",
    }]), analysis());

    const pages = enriched.sections[0]!.pages;
    expect(pages.map((page) => page.id)).toEqual([
      "condition-operators/starts-with",
      "condition-operators/greater-than",
      "condition-operators/matches-regex",
      "condition-operators/in-segment",
    ]);
    expect(pages.every((page) => page.group === "Condition Operators")).toBe(true);
    expect(pages.map((page) => page.collectionItemId)).toEqual(
      collection().items.map((item) => item.id),
    );
  });

  test("is stable across different planner output for the same collection", () => {
    const first = applyCollectionsToStructure(structure([]), analysis());
    const second = applyCollectionsToStructure(structure([{
      id: "operators-guide",
      title: "Condition Operators Guide",
      description: "Different planner prose.",
    }]), analysis());

    expect(second).toEqual(first);
  });

  test("keeps existing item evidence while restoring canonical prose", () => {
    const enriched = applyCollectionsToStructure(structure([{
      id: "condition-operators/starts-with",
      title: "Starts with",
      description: "Model prose.",
      collectionId: "condition-operators",
      collectionItemId: "condition-operators/starts-with",
      sourceEvidence: [{ path: "src/extra.ts", kind: "source" }],
    }]), analysis());

    const page = enriched.sections[0]!.pages[0]!;
    expect(page.description).toBe("Matches when the value starts with the configured prefix.");
    expect(page.sourceEvidence?.map((evidence) => evidence.path)).toEqual([
      "src/extra.ts",
      "src/operators.ts",
    ]);
  });

  test("does not let a later collection replace pages already assigned to another collection", () => {
    const second: DocumentationCollection = {
      ...collection(),
      id: "control-plane-operators",
      title: "Control Plane Operators",
      items: collection().items.map((item) => ({
        ...item,
        id: item.id.replace("condition-operators", "control-plane-operators"),
      })),
    };
    const enriched = applyCollectionsToStructure(structure([]), {
      ...analysisFixture,
      documentationCollections: [collection(), second],
    });

    expect(enriched.sections[0]!.pages.filter(
      (page) => page.collectionId === "condition-operators",
    )).toHaveLength(4);
    expect(enriched.sections[0]!.pages.filter(
      (page) => page.collectionId === "control-plane-operators",
    )).toHaveLength(4);
  });

  test("replaces planner pages written for single items instead of duplicating them", () => {
    const plannerDescription = "Compare a value against a prefix and route matching users to the variant.";
    const sections: DocumentationStructure["sections"] = [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          { id: "introduction", title: "Introduction", description: plannerDescription },
          {
            id: "rules/prefix",
            title: "Starts with",
            description: plannerDescription,
            canonicalRoute: "/rules/prefix",
          },
          { id: "greater-than", title: "Greater than", description: plannerDescription },
        ],
      },
      {
        id: "guides",
        title: "Guides",
        pages: [
          { id: "regex-matching", title: "Matches regex", description: plannerDescription },
          { id: "in-segment", title: "Segments", description: plannerDescription },
        ],
      },
    ];

    const enriched = applyCollectionsToStructure({ sections }, analysis());

    expect(enriched.sections.map((section) => section.pages.map((page) => page.id))).toEqual([
      [
        "introduction",
        "condition-operators/starts-with",
        "condition-operators/greater-than",
        "condition-operators/matches-regex",
        "condition-operators/in-segment",
      ],
      [],
    ]);
    const [, startsWith, greaterThan] = enriched.sections[0]!.pages;
    expect(startsWith?.canonicalRoute).toBe("/rules/prefix");
    expect(greaterThan?.description).toBe(plannerDescription);
    expect(
      validateDocumentationStructureForProfile(enriched, analysis()).errors.filter((error) =>
        error.startsWith("Duplicate page title") || error.includes("weak or missing description")
      ),
    ).toEqual([]);
  });

  test("replaces a short item description that no planner page can fill", () => {
    const enriched = applyCollectionsToStructure(structure([]), analysis());

    const greaterThan = enriched.sections[0]!.pages.find((page) => page.id === "condition-operators/greater-than");
    expect(greaterThan?.description).toBe(
      "Install, configure, and use Greater than as one of the supported condition operators for this project.",
    );
    expect(
      validateDocumentationStructureForProfile(enriched, analysis()).errors.filter((error) =>
        error.includes("weak or missing description")
      ),
    ).toEqual([]);
  });
});
