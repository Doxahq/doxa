import { describe, expect, test } from "vitest";
import {
  buildWriterHandoff,
  selectWriterPageBriefs,
} from "../src/doxa-agent/writer-handoff";
import { analysisFixture, structureFixture } from "./fixtures";

describe("planner-to-writer handoff", () => {
  test("builds deterministic page briefs from accepted planning state", () => {
    const handoff = buildWriterHandoff({
      analysis: {
        ...analysisFixture,
        documentationIntent: {
          audience: "consumer",
          primaryUseCase: "Integrate the fixture library.",
          publicPackageNames: ["fixture"],
          canonicalWorkflows: [],
          internalOnlyPaths: ["scripts/internal.ts"],
          consumerTerminology: ["fixture client"],
        },
      },
      structure: structureFixture,
      sourceRevision: "a".repeat(40),
      project: { name: "Fixture", slug: "fixture" },
    });

    expect(handoff.pages.map((page) => page.pageId)).toEqual([
      "default/overview",
      "default/guides",
      "default/guides/install",
    ]);
    expect(handoff.pages[0]).toMatchObject({
      route: "/overview",
      purpose: "Project overview.",
      sourceEvidence: [{
        path: "src/index.ts",
        symbols: [],
      }],
      exclusions: ["scripts/internal.ts"],
    });
    expect(handoff.shared.terminology).toEqual(["fixture client"]);
  });

  test("selects only briefs requested by a write batch", () => {
    const handoff = buildWriterHandoff({
      analysis: analysisFixture,
      structure: structureFixture,
      sourceRevision: null,
      project: { name: "Fixture", slug: "fixture" },
    });

    expect(
      selectWriterPageBriefs(handoff, ["default/guides/install"])
        .pages.map((page) => page.pageId),
    ).toEqual(["default/guides/install"]);
    expect(() =>
      selectWriterPageBriefs(handoff, ["missing"]),
    ).toThrow("Writer handoff is missing page brief: missing");
  });

  test("falls back when normalized documentation intent has an empty goal", () => {
    const handoff = buildWriterHandoff({
      analysis: {
        ...analysisFixture,
        documentationIntent: {
          audience: "consumer",
          primaryUseCase: "",
          publicPackageNames: [],
          canonicalWorkflows: [],
          internalOnlyPaths: [],
          consumerTerminology: [],
        },
      },
      structure: structureFixture,
      sourceRevision: null,
      project: { name: "Fixture", slug: "fixture" },
    });

    expect(handoff.project.documentationGoal).toBe(
      analysisFixture.projectDescription,
    );
  });
});
