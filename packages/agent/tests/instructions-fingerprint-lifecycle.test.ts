import {
  DEFAULT_DOXABOT_INSTRUCTIONS,
  doxabotPathGlobSchema,
  generationInstructionsFingerprint,
  type DoxabotInstructions,
  type GenerationInstructions,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  NO_PROJECT_INSTRUCTIONS_FINGERPRINT,
  catchUpInstructionPages,
  documentationBriefFingerprint,
  instructionCatchUpEdits,
  pagesBehindInstructions,
  planRevisionAwareGeneration,
  resolveDocumentationBrief,
  runInstructionsFingerprint,
  type PriorRevisionGenerationState,
} from "../src";

const NO_DEPENDENCIES = {
  sourceFilesRead: [],
  sourceFilesDiscovered: [],
  sourceEvidenceFiles: [],
  referencedSymbols: [],
  referencedRoutes: [],
};

function runInstructions(instructions: Partial<DoxabotInstructions> = {}): GenerationInstructions {
  return {
    version: 1,
    instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, ...instructions },
    screening: { method: "heuristic", flags: [] },
    repositoryFile: { status: "disabled" },
  };
}

function runFingerprint(projectInstructions: GenerationInstructions): string {
  return runInstructionsFingerprint(resolveDocumentationBrief({ target: { kind: "public" }, projectInstructions }));
}

describe("instructions fingerprint", () => {
  test("lists whose order means nothing give the same fingerprint in any order", async () => {
    const saved = runInstructions({
      pageTypes: ["quickstart", "guides", "concepts"],
      doNotDocument: ["internal/**", "scripts/**"],
      terminology: [
        { use: "workspace", avoid: ["org", "organization"] },
        { use: "payout", avoid: ["transfer"] },
      ],
    });
    // Turning guides off and on again moves it to the end in the dashboard.
    const reordered = runInstructions({
      pageTypes: ["quickstart", "concepts", "guides"],
      doNotDocument: ["scripts/**", "internal/**", "internal/**"],
      terminology: [
        { use: "payout", avoid: ["transfer"] },
        { use: "workspace", avoid: ["organization", "org"] },
      ],
    });

    expect(await generationInstructionsFingerprint(reordered)).toBe(await generationInstructionsFingerprint(saved));
    expect(runFingerprint(reordered)).toBe(runFingerprint(saved));
  });

  test("the order of code languages and rules still counts", async () => {
    const first = runInstructions({ codeLanguages: ["typescript", "python"], rules: ["One.", "Two."] });

    expect(await generationInstructionsFingerprint(runInstructions({ codeLanguages: ["python", "typescript"], rules: ["One.", "Two."] })))
      .not.toBe(await generationInstructionsFingerprint(first));
    expect(await generationInstructionsFingerprint(runInstructions({ codeLanguages: ["typescript", "python"], rules: ["Two.", "One."] })))
      .not.toBe(await generationInstructionsFingerprint(first));
  });

  test("the defaults count as no instructions, so a first save of them rewrites nothing", async () => {
    const defaults = runInstructions({ pageTypes: ["troubleshooting", "quickstart", "guides", "reference", "concepts"] });

    await expect(generationInstructionsFingerprint(defaults)).resolves.toBe(NO_PROJECT_INSTRUCTIONS_FINGERPRINT);
    expect(runFingerprint(defaults)).toBe(NO_PROJECT_INSTRUCTIONS_FINGERPRINT);
  });

  test("defaults with flagged text or a repository file still count as instructions", async () => {
    const flagged: GenerationInstructions = {
      ...runInstructions(),
      screening: { method: "heuristic", flags: [{ field: "context", index: null }] },
    };
    const withFile: GenerationInstructions = {
      ...runInstructions({ repositoryFile: { enabled: true } }),
      repositoryFile: { status: "found", text: "Use short sentences.", flagged: false },
    };

    await expect(generationInstructionsFingerprint(flagged)).resolves.not.toBe(NO_PROJECT_INSTRUCTIONS_FINGERPRINT);
    await expect(generationInstructionsFingerprint(withFile)).resolves.not.toBe(NO_PROJECT_INSTRUCTIONS_FINGERPRINT);
  });

  test("saving the defaults keeps the analysis brief of a project without instructions", () => {
    const brief = (projectInstructions?: GenerationInstructions) =>
      documentationBriefFingerprint(resolveDocumentationBrief({ target: { kind: "public" }, projectInstructions }));

    expect(brief(runInstructions())).toBe(brief(undefined));
    expect(brief(runInstructions({ voice: { tone: "formal", address: "second_person" } }))).not.toBe(brief(undefined));
  });

  test("the screening method does not count, its flags do", async () => {
    const withMethod = (method: "heuristic" | "model", flags: GenerationInstructions["screening"]["flags"]) => ({
      ...runInstructions({ rules: ["Use short sentences.", "Mention pricing."] }),
      screening: { method, flags },
    });
    const flagged = [{ field: "rules" as const, index: 1 }];

    await expect(generationInstructionsFingerprint(withMethod("model", flagged)))
      .resolves.toBe(await generationInstructionsFingerprint(withMethod("heuristic", flagged)));
    await expect(generationInstructionsFingerprint(withMethod("heuristic", [])))
      .resolves.not.toBe(await generationInstructionsFingerprint(withMethod("heuristic", flagged)));
    expect(runFingerprint(withMethod("model", flagged))).toBe(await generationInstructionsFingerprint(withMethod("heuristic", flagged)));
  });

  test("the API and a run agree for changed instructions", async () => {
    const changed = runInstructions({ voice: { tone: "formal", address: "second_person" } });

    await expect(generationInstructionsFingerprint(changed)).resolves.toBe(runFingerprint(changed));
  });
});

describe("do-not-document glob rules", () => {
  test.each([
    ["internal/**"],
    ["apps/*/src/**/*.{routes,handlers}.ts"],
    [".github/**"],
  ])("accepts %s", (glob) => {
    expect(doxabotPathGlobSchema.safeParse(glob).success).toBe(true);
  });

  test.each([
    ["{a,b}/{a,b}/{a,b}/{a,b}/{a,b}/{a,b}/{a,b}/{a,b}/{a,b}", /at most 256 patterns/],
    ["src/[abc].ts", /path glob such as/],
    ["./internal/**", /without \.\/ in front/],
    ["/internal/**", /without a leading/],
  ])("refuses %s", (glob, message) => {
    const result = doxabotPathGlobSchema.safeParse(glob);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(" ")).toMatch(message);
  });
});

describe("pages kept through an instructions change", () => {
  const previous: PriorRevisionGenerationState = {
    planningFingerprint: "planning",
    writingFingerprint: "writing",
    projectInstructionsFingerprint: "instructions-new",
    structuralFingerprint: "structure",
    pages: [
      { pageId: "overview", pageInputHash: "a", dependencies: NO_DEPENDENCIES },
      // A locked page that the instructions change kept.
      { pageId: "locked", pageInputHash: "b", dependencies: NO_DEPENDENCIES, projectInstructionsFingerprint: "instructions-old" },
      { pageId: "current", pageInputHash: "c", dependencies: NO_DEPENDENCIES, projectInstructionsFingerprint: "instructions-new" },
    ],
  };

  const plan = (projectInstructionsFingerprint: string, state: PriorRevisionGenerationState = previous) =>
    planRevisionAwareGeneration({
      currentPageIds: ["overview", "locked", "current"],
      currentPageInputHashes: { overview: "a", locked: "b", current: "c" },
      changes: [],
      planningFingerprint: "planning",
      writingFingerprint: "writing",
      structuralFingerprint: "structure",
      projectInstructionsFingerprint,
      previous: state,
    });

  test("are found by their own fingerprint, and legacy pages follow their run", () => {
    expect([...pagesBehindInstructions(previous, "instructions-new")]).toEqual(["locked"]);
    expect(pagesBehindInstructions(previous, undefined).size).toBe(0);
  });

  test("are written again in a later run with no other change", () => {
    const next = plan("instructions-new");

    expect(next).toMatchObject({
      analysisMode: "reuse",
      structureMode: "reuse",
      regeneratePageIds: ["locked"],
      reusePageIds: ["overview", "current"],
      modelCallsRequired: true,
    });
    expect(next.reasons.join(" ")).toMatch(/kept through an instructions change/);
    expect(next.catchUpPageIds).toEqual(["locked"]);
  });

  test("stop after the ledger says a page failed to catch up too many runs in a row", () => {
    const exhausted: PriorRevisionGenerationState = { ...previous, exhaustedCatchUpPageIds: ["locked"] };

    expect(pagesBehindInstructions(exhausted, "instructions-new").size).toBe(0);
    expect(plan("instructions-new", exhausted)).toMatchObject({
      regeneratePageIds: [],
      modelCallsRequired: false,
    });
    expect(plan("instructions-new").regeneratePageIds).toEqual(["locked"]);
  });

  test("are not catch-up pages in the run where the instructions change", () => {
    const next = plan("instructions-newer");

    expect(pagesBehindInstructions(previous, "instructions-newer").size).toBe(0);
    expect(next.editReason).toBe("instructions_changed");
    expect(next.regeneratePageIds).toEqual(["overview", "locked", "current"]);
    expect(next.catchUpPageIds).toBeUndefined();
  });

  test("leave a site whose pages all follow the instructions alone", () => {
    const allCurrent: PriorRevisionGenerationState = {
      ...previous,
      pages: previous.pages.filter((page) => page.pageId !== "locked"),
    };

    expect(plan("instructions-new", allCurrent)).toMatchObject({
      regeneratePageIds: [],
      modelCallsRequired: false,
    });
  });

  test("count as instructions changes in a page-level plan, and template pages stay", () => {
    const caughtUp = catchUpInstructionPages({
      plan: {
        analysisMode: "incremental",
        structureMode: "reuse",
        regeneratePageIds: ["current"],
        reusePageIds: ["overview", "locked", "endpoint"],
        removedPageIds: [],
        modelCallsRequired: true,
        reasons: ["Page current depends on changed source."],
        causes: { newPages: 0, inputChanged: 0, dependencyChanged: 1 },
      },
      currentPageIds: ["overview", "locked", "current", "endpoint"],
      behindPageIds: new Set(["locked", "endpoint"]),
      templatePageIds: new Set(["endpoint"]),
    });

    expect(caughtUp.regeneratePageIds).toEqual(["locked", "current"]);
    expect(caughtUp.reusePageIds).toEqual(["overview", "endpoint"]);
    expect(caughtUp.causes).toEqual({ newPages: 0, inputChanged: 0, dependencyChanged: 1, instructionsChanged: 1 });
  });

  test("are edited from their published text", () => {
    expect(instructionCatchUpEdits({
      pageIds: ["locked", "new-page"],
      previousPages: [{ pageId: "locked", artifactKey: "v1/locked.mdx" }],
      edits: { current: { artifactKey: "v1/current.mdx", changedSources: ["src/a.ts"] } },
    })).toEqual({
      current: { artifactKey: "v1/current.mdx", changedSources: ["src/a.ts"] },
      locked: { artifactKey: "v1/locked.mdx", changedSources: [], instructionsChanged: true },
    });
  });
});

describe("an instructions change in the same run as a planning contract change", () => {
  const previous: PriorRevisionGenerationState = {
    planningFingerprint: "planning-v8",
    writingFingerprint: "writing",
    projectInstructionsFingerprint: "instructions-old",
    structuralFingerprint: "structure",
    pages: [{ pageId: "overview", pageInputHash: "a", dependencies: NO_DEPENDENCIES }],
  };
  const plan = (projectInstructionsFingerprint: string) =>
    planRevisionAwareGeneration({
      currentPageIds: ["overview"],
      currentPageInputHashes: { overview: "a" },
      changes: [],
      planningFingerprint: "planning-v9",
      writingFingerprint: "writing",
      structuralFingerprint: "structure",
      projectInstructionsFingerprint,
      previous,
    });

  test("still tells the structure step that the instructions changed", () => {
    expect(plan("instructions-new")).toMatchObject({
      analysisMode: "full",
      structureMode: "regenerate",
      regeneratePageIds: ["overview"],
      editReason: "instructions_changed",
    });
  });

  test("a planning change alone is not an instructions change", () => {
    expect(plan("instructions-old").editReason).toBeUndefined();
  });
});
