import {
  DEFAULT_DOXABOT_INSTRUCTIONS,
  MAX_INSTRUCTION_CATCH_UP_ATTEMPTS,
  generationInstructionsFingerprint,
  instructionCatchUpLedgerKey,
  type GenerationInstructions,
} from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  createInstructionsChangeCheck,
  readPublishedInstructionsState,
} from "../../src/services/doxabot/instructions-change";
import { RepositoryInstructionsUnavailableError } from "../../src/services/doxabot/repository-instructions-file";
import type { ProjectInstructionVersion } from "../../src/repositories/project-instructions";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const location = {
  siteId: "site-1",
  generationStatePrefix: `sites/site-1/generation-state/${VERSION_ID}`,
};
const baseline = {
  ...location,
  versionId: VERSION_ID,
  sourceRevision: "a".repeat(40),
  sourceTreeHash: "b".repeat(40),
  generatorFingerprint: "generator",
};
const ANALYSIS_KEY = `${location.generationStatePrefix}/analysis.json`;
const SCREENING: ProjectInstructionVersion["screening"] = { method: "heuristic", flags: [] };

function storedVersion(context: string): ProjectInstructionVersion {
  return {
    version: 2,
    createdAt: new Date("2026-11-05T00:00:00.000Z"),
    createdBy: null,
    instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, context },
    screening: SCREENING,
  };
}

function runInstructions(context: string, version = 1): GenerationInstructions {
  return {
    version,
    instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, context },
    screening: SCREENING,
    repositoryFile: { status: "disabled" },
  };
}

function bucketWith(files: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) =>
      key in files
        ? { text: async () => (typeof files[key] === "string" ? files[key] : JSON.stringify(files[key])) }
        : null),
  } as unknown as Pick<R2Bucket, "get">;
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    siteId: "site-1",
    versionId: VERSION_ID,
    baselineVersionId: null,
    generatorFingerprint: "generator",
    sourceRevision: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    source: { key: `${location.generationStatePrefix}/source.json`, hash: "c".repeat(64) },
    analysis: { key: ANALYSIS_KEY, hash: "c".repeat(64) },
    structure: { key: `${location.generationStatePrefix}/structure.json`, hash: "c".repeat(64) },
    pages: [],
    createdAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

function analysis(fingerprint?: string) {
  return {
    schemaVersion: 1,
    analysis: {},
    analysisHash: "d".repeat(64),
    sourceSummaries: [],
    ...(fingerprint ? { projectInstructionsFingerprint: fingerprint } : {}),
  };
}

function publishedState(fingerprint: string, pagesBehindInstructions = 0) {
  return vi.fn(async () => ({ fingerprint, pagesBehindInstructions }));
}

function check(
  published: string | null,
  current: ProjectInstructionVersion | null,
  pagesBehindInstructions = 0,
) {
  return createInstructionsChangeCheck({
    sources: {
      getCurrent: vi.fn(async () => current),
      readRepositoryFile: vi.fn(async () => ({ status: "missing" as const })),
    },
    readPublishedState: published === null
      ? vi.fn(async () => null)
      : publishedState(published, pagesBehindInstructions),
  }).changedSincePublished({ projectId: "project-1", baseline });
}

describe("instructions change since the published docs", () => {
  test("reports a change when the saved instructions differ", async () => {
    const published = await generationInstructionsFingerprint(runInstructions("Old context."));

    await expect(check(published, storedVersion("New context."))).resolves.toBe("changed");
  });

  test("reports no change for the same content under a newer version number", async () => {
    const published = await generationInstructionsFingerprint(runInstructions("Same context.", 1));

    await expect(check(published, storedVersion("Same context."))).resolves.toBe("unchanged");
  });

  test("reports a change when a project without instructions saves its first ones", async () => {
    await expect(check("none", storedVersion("First context."))).resolves.toBe("changed");
  });

  test("reports no change for a project that never had instructions", async () => {
    await expect(check("none", null)).resolves.toBe("unchanged");
  });

  test("reports a change when published pages are still behind the instructions", async () => {
    const published = await generationInstructionsFingerprint(runInstructions("Same context."));

    await expect(check(published, storedVersion("Same context."), 2)).resolves.toBe("changed");
  });

  test("reports unknown when the published instructions cannot be read", async () => {
    await expect(check(null, storedVersion("New context."))).resolves.toBe("unknown");
  });

  test("reports unknown when an enabled repository file cannot be read", async () => {
    const stored = storedVersion("Same context.");
    stored.instructions = { ...stored.instructions, repositoryFile: { enabled: true } };

    const changed = await createInstructionsChangeCheck({
      sources: {
        getCurrent: vi.fn(async () => stored),
        readRepositoryFile: vi.fn(async () => {
          throw new RepositoryInstructionsUnavailableError();
        }),
      },
      readPublishedState: publishedState("fingerprint-1"),
    }).changedSincePublished({ projectId: "project-1", baseline });

    expect(changed).toBe("unknown");
  });

  test("reads the repository file when the instructions enable it", async () => {
    const stored = storedVersion("Same context.");
    stored.instructions = {
      ...stored.instructions,
      repositoryFile: { ...stored.instructions.repositoryFile, enabled: true },
    };
    const published = await generationInstructionsFingerprint({
      version: 1,
      instructions: stored.instructions,
      screening: stored.screening,
      repositoryFile: { status: "found", text: "Old file.", flagged: false },
    });
    const readRepositoryFile = vi.fn(async () => ({
      status: "found" as const,
      text: "New file.",
      flagged: false,
    }));

    const changed = await createInstructionsChangeCheck({
      sources: { getCurrent: vi.fn(async () => stored), readRepositoryFile },
      readPublishedState: publishedState(published),
    }).changedSincePublished({ projectId: "project-1", baseline });

    expect(changed).toBe("changed");
    expect(readRepositoryFile).toHaveBeenCalledWith("project-1");
  });
});

describe("published instructions state", () => {
  test("reads the fingerprint and the pages behind it through the state manifest", async () => {
    const bucket = bucketWith({
      [`${location.generationStatePrefix}/manifest.json`]: manifest({ behindInstructionPageIds: ["a", "b", "c"] }),
      [ANALYSIS_KEY]: analysis("fingerprint-1"),
    });

    await expect(readPublishedInstructionsState(bucket, location)).resolves.toEqual({
      fingerprint: "fingerprint-1",
      pagesBehindInstructions: 3,
    });
  });

  test("leaves out the pages that the catch-up ledger says runs stopped trying", async () => {
    const files = (ledgerFingerprint: string) => ({
      [`${location.generationStatePrefix}/manifest.json`]: manifest({ behindInstructionPageIds: ["a", "b"] }),
      [ANALYSIS_KEY]: analysis("fingerprint-1"),
      [instructionCatchUpLedgerKey("site-1")]: {
        schemaVersion: 1,
        instructionsFingerprint: ledgerFingerprint,
        lastJobId: "job-3",
        attempts: { a: MAX_INSTRUCTION_CATCH_UP_ATTEMPTS, b: 1 },
      },
    });

    await expect(readPublishedInstructionsState(bucketWith(files("fingerprint-1")), location))
      .resolves.toEqual({ fingerprint: "fingerprint-1", pagesBehindInstructions: 1 });
    // A ledger for other instructions counts as empty.
    await expect(readPublishedInstructionsState(bucketWith(files("fingerprint-0")), location))
      .resolves.toEqual({ fingerprint: "fingerprint-1", pagesBehindInstructions: 2 });
  });

  test("counts every listed page when the ledger is malformed", async () => {
    const bucket = bucketWith({
      [`${location.generationStatePrefix}/manifest.json`]: manifest({ behindInstructionPageIds: ["a"] }),
      [ANALYSIS_KEY]: analysis("fingerprint-1"),
      [instructionCatchUpLedgerKey("site-1")]: { schemaVersion: 1, attempts: "broken" },
    });

    await expect(readPublishedInstructionsState(bucket, location))
      .resolves.toEqual({ fingerprint: "fingerprint-1", pagesBehindInstructions: 1 });
  });

  test("treats state from before instructions as no instructions and no pages behind", async () => {
    const bucket = bucketWith({
      [`${location.generationStatePrefix}/manifest.json`]: manifest(),
      [ANALYSIS_KEY]: analysis(),
    });

    await expect(readPublishedInstructionsState(bucket, location)).resolves.toEqual({
      fingerprint: "none",
      pagesBehindInstructions: 0,
    });
  });

  test.each([
    ["no manifest", {}],
    ["a manifest of another version", {
      [`${location.generationStatePrefix}/manifest.json`]: manifest({ versionId: "another-version" }),
      [ANALYSIS_KEY]: analysis("fingerprint-1"),
    }],
    ["no analysis object", { [`${location.generationStatePrefix}/manifest.json`]: manifest() }],
    ["a manifest that is not JSON", { [`${location.generationStatePrefix}/manifest.json`]: "{" }],
  ])("returns null with %s", async (_name, files) => {
    await expect(readPublishedInstructionsState(bucketWith(files), location)).resolves.toBeNull();
  });

  test("returns null when the bucket read fails", async () => {
    const bucket = {
      get: vi.fn(async () => {
        throw new Error("R2 failed");
      }),
    } as unknown as Pick<R2Bucket, "get">;

    await expect(readPublishedInstructionsState(bucket, location)).resolves.toBeNull();
  });
});
