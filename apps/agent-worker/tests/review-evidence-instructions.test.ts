import {
  GENERATION_STATE_SCHEMA_VERSION,
  emptyPageDependencyState,
  incrementalGenerationPlanSchema,
  type GenerationPageState,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import { pageInstructionsFingerprints } from "../src/review-evidence";

const hash = "a".repeat(64);

function statePage(pageId: string, projectInstructionsFingerprint?: string): GenerationPageState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    pageId,
    title: pageId,
    route: `/${pageId}`,
    navigationPath: `default/${pageId}.md`,
    artifactKey: `sites/site-1/versions/version-1/source/${pageId}/index.mdx`,
    contentHash: hash,
    pageInputHash: hash,
    dependencies: emptyPageDependencyState(),
    ...(projectInstructionsFingerprint ? { projectInstructionsFingerprint } : {}),
  };
}

const plan = incrementalGenerationPlanSchema.parse({
  analysisMode: "full",
  structureMode: "regenerate",
  regeneratePageIds: ["written"],
  reusePageIds: ["kept", "legacy"],
  removedPageIds: [],
  modelCallsRequired: true,
  reasons: ["The project instructions changed."],
});

describe("page instructions fingerprints", () => {
  test("gives written pages the run's value and kept pages their own", () => {
    const instructionsOf = pageInstructionsFingerprints({
      plan,
      runFingerprint: "instructions-new",
      previousPages: [statePage("kept", "instructions-old"), statePage("legacy")],
      previousRunFingerprint: "instructions-published",
    });

    expect(instructionsOf("written")).toBe("instructions-new");
    expect(instructionsOf("kept")).toBe("instructions-old");
    // A page stored before the field follows the run that stored it.
    expect(instructionsOf("legacy")).toBe("instructions-published");
  });
});
