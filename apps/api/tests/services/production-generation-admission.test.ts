import {
  EDITOR_CONTENT_GENERATION_MESSAGE,
  UNCHANGED_SOURCE_INSTRUCTIONS_UNKNOWN_MESSAGE,
  type GenerationExecutionConfig,
  type GenerationJobDto,
} from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  ProductionGenerationAdmissionService,
  type ProductionGenerationBaseline,
} from "../../src/services/production-generation-admission";

const executionConfig: GenerationExecutionConfig = {
  plannerModel: "x-ai/grok-4.5:nitro",
  writerModel: "moonshotai/kimi-k2.6:nitro",
  generationProfile: "full-prod",
  planningFingerprint: "planning-v1",
  writingFingerprint: "writing-v1",
  generatorFingerprint:
    "doxabot-v1:x-ai/grok-4.5:full-prod:100",
};

const baselineState = {
  siteId: "site-1",
  generationStatePrefix: "sites/site-1/generation-state/11111111-1111-4111-8111-111111111111",
};

describe("production generation admission", () => {
  test("captures the exact default-branch revision and compatible baseline", async () => {
    const targetRevision = "b".repeat(40);
    const targetTreeHash = "c".repeat(40);
    const baseline: ProductionGenerationBaseline = {
      versionId: "11111111-1111-4111-8111-111111111111",
      sourceRevision: "a".repeat(40),
      sourceTreeHash: "d".repeat(40),
      generatorFingerprint: executionConfig.generatorFingerprint,
      ...baselineState,
    };
    const resolveTarget = vi.fn(async () => ({
      revision: targetRevision,
      treeHash: targetTreeHash,
    }));
    const findCompatiblePublished = vi.fn(async () => baseline);
    const create = vi.fn(async () => ({
      outcome: "created" as const,
      job: queuedJob(),
    }));
    const service = new ProductionGenerationAdmissionService({
      source: { resolveTarget },
      baselines: {
        findCompatiblePublished,
        handWrittenVersion: noHandWrittenVersion,
      },
      jobs: { create },
      instructions: instructionsUnchanged(),
      executionConfig,
    });

    await service.admit({
      projectId: "project-1",
      userId: "user-1",
    });

    expect(findCompatiblePublished).toHaveBeenCalledWith({
      projectId: "project-1",
    });
    expect(create).toHaveBeenCalledWith({
      projectId: "project-1",
      userId: "user-1",
      trigger: "manual",
      baselineRevision: "a".repeat(40),
      targetRevision,
      sourceTreeHash: targetTreeHash,
      baselineVersionId: baseline.versionId,
      seedVersionId: null,
      ...executionConfig,
    });
  });

  test("uses the target itself as the checkout baseline when no compatible state exists", async () => {
    const targetRevision = "c".repeat(40);
    const targetTreeHash = "d".repeat(40);
    const create = vi.fn(async () => ({
      outcome: "created" as const,
      job: queuedJob(),
    }));
    const service = new ProductionGenerationAdmissionService({
      source: {
          resolveTarget: vi.fn(async () => ({
          revision: targetRevision,
          treeHash: targetTreeHash,
        })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => null),
        handWrittenVersion: noHandWrittenVersion,
      },
      jobs: { create },
      instructions: instructionsUnchanged(),
      executionConfig,
    });

    await service.admit({
      projectId: "project-1",
      userId: "user-1",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineRevision: targetRevision,
        targetRevision,
        sourceTreeHash: targetTreeHash,
        baselineVersionId: null,
      }),
    );
  });

  test("requires confirmation when source content and generation configuration are unchanged", async () => {
    const revision = "a".repeat(40);
    const treeHash = "b".repeat(40);
    const create = vi.fn();
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({ revision, treeHash })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => ({
          versionId: "11111111-1111-4111-8111-111111111111",
          sourceRevision: revision,
          sourceTreeHash: treeHash,
          generatorFingerprint: executionConfig.generatorFingerprint,
          ...baselineState,
        })),
        handWrittenVersion: noHandWrittenVersion,
      },
      jobs: { create },
      instructions: instructionsUnchanged(),
      executionConfig,
    });

    await expect(service.admit({
      projectId: "project-1",
      userId: "user-1",
      force: false,
    })).resolves.toEqual({
      outcome: "confirmation_required",
      reason: "unchanged_source",
      message:
        "The repository content, Doxabot instructions, and generation configuration have not changed since the current production deployment. A new generation will likely produce the same documentation.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("creates a forced generation when source content is unchanged", async () => {
    const revision = "a".repeat(40);
    const treeHash = "b".repeat(40);
    const create = vi.fn(async () => ({
      outcome: "created" as const,
      job: queuedJob(),
    }));
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({ revision, treeHash })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => ({
          versionId: "11111111-1111-4111-8111-111111111111",
          sourceRevision: revision,
          sourceTreeHash: treeHash,
          generatorFingerprint: executionConfig.generatorFingerprint,
          ...baselineState,
        })),
        handWrittenVersion: noHandWrittenVersion,
      },
      jobs: { create },
      instructions: instructionsUnchanged(),
      executionConfig,
    });

    await expect(service.admit({
      projectId: "project-1",
      userId: "user-1",
      force: true,
    })).resolves.toMatchObject({ outcome: "created" });
    expect(create).toHaveBeenCalledOnce();
  });

  test("creates a generation when the generator configuration changed", async () => {
    const revision = "a".repeat(40);
    const treeHash = "b".repeat(40);
    const create = vi.fn(async () => ({
      outcome: "created" as const,
      job: queuedJob(),
    }));
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({ revision, treeHash })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => ({
          versionId: "11111111-1111-4111-8111-111111111111",
          sourceRevision: revision,
          sourceTreeHash: treeHash,
          generatorFingerprint: "older-generator",
          ...baselineState,
        })),
        handWrittenVersion: noHandWrittenVersion,
      },
      jobs: { create },
      instructions: instructionsUnchanged(),
      executionConfig,
    });

    await expect(service.admit({
      projectId: "project-1",
      userId: "user-1",
      force: false,
    })).resolves.toMatchObject({ outcome: "created" });
    expect(create).toHaveBeenCalledOnce();
  });

  test("starts without asking when only the instructions changed", async () => {
    const revision = "a".repeat(40);
    const treeHash = "b".repeat(40);
    const baseline = {
      versionId: "11111111-1111-4111-8111-111111111111",
      sourceRevision: revision,
      sourceTreeHash: treeHash,
      generatorFingerprint: executionConfig.generatorFingerprint,
      ...baselineState,
    };
    const create = vi.fn(async () => ({
      outcome: "created" as const,
      job: queuedJob(),
    }));
    const changedSincePublished = vi.fn(async () => "changed" as const);
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({ revision, treeHash })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => baseline),
        handWrittenVersion: noHandWrittenVersion,
      },
      jobs: { create },
      instructions: { changedSincePublished },
      executionConfig,
    });

    await expect(service.admit({
      projectId: "project-1",
      userId: "user-1",
      force: false,
    })).resolves.toMatchObject({ outcome: "created" });
    expect(changedSincePublished).toHaveBeenCalledWith({
      projectId: "project-1",
      baseline,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineVersionId: baseline.versionId,
        baselineRevision: revision,
        targetRevision: revision,
      }),
    );
  });

  test("asks first with a neutral message when the instructions cannot be checked", async () => {
    const create = vi.fn(async () => ({
      outcome: "created" as const,
      job: queuedJob(),
    }));
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({ revision: "a".repeat(40), treeHash: "b".repeat(40) })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => ({
          versionId: "11111111-1111-4111-8111-111111111111",
          sourceRevision: "a".repeat(40),
          sourceTreeHash: "b".repeat(40),
          generatorFingerprint: executionConfig.generatorFingerprint,
          ...baselineState,
        })),
        handWrittenVersion: noHandWrittenVersion,
      },
      jobs: { create },
      instructions: { changedSincePublished: vi.fn(async () => "unknown" as const) },
      executionConfig,
    });

    await expect(service.admit({ projectId: "project-1", userId: "user-1" })).resolves.toEqual({
      outcome: "confirmation_required",
      reason: "unchanged_source",
      message: UNCHANGED_SOURCE_INSTRUCTIONS_UNKNOWN_MESSAGE,
    });
    expect(UNCHANGED_SOURCE_INSTRUCTIONS_UNKNOWN_MESSAGE).not.toMatch(/instructions[^.]*have not changed/);
    expect(create).not.toHaveBeenCalled();
  });

  test("does not read the instructions when the source changed", async () => {
    const changedSincePublished = vi.fn(async () => "unchanged" as const);
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({
          revision: "c".repeat(40),
          treeHash: "d".repeat(40),
        })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => ({
          versionId: "11111111-1111-4111-8111-111111111111",
          sourceRevision: "a".repeat(40),
          sourceTreeHash: "b".repeat(40),
          generatorFingerprint: executionConfig.generatorFingerprint,
          ...baselineState,
        })),
        handWrittenVersion: noHandWrittenVersion,
      },
      jobs: {
        create: vi.fn(async () => ({
          outcome: "created" as const,
          job: queuedJob(),
        })),
      },
      instructions: { changedSincePublished },
      executionConfig,
    });

    await service.admit({ projectId: "project-1", userId: "user-1" });

    expect(changedSincePublished).not.toHaveBeenCalled();
  });

  test("asks before the first generation replaces hand-written pages", async () => {
    const create = vi.fn();
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({
          revision: "c".repeat(40),
          treeHash: "d".repeat(40),
        })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => null),
        handWrittenVersion: vi.fn(async () => "editor-version-1"),
      },
      jobs: { create },
      instructions: instructionsUnchanged(),
      executionConfig,
    });

    await expect(
      service.admit({ projectId: "project-1", userId: "user-1" }),
    ).resolves.toEqual({
      outcome: "confirmation_required",
      reason: "editor_content",
      message: EDITOR_CONTENT_GENERATION_MESSAGE,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("starts a seeded run from the hand-written version when asked", async () => {
    const create = vi.fn(async () => ({
      outcome: "created" as const,
      job: queuedJob(),
    }));
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({
          revision: "c".repeat(40),
          treeHash: "d".repeat(40),
        })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => null),
        handWrittenVersion: vi.fn(async () => "editor-version-1"),
      },
      jobs: { create },
      instructions: instructionsUnchanged(),
      executionConfig,
    });

    await service.admit({
      projectId: "project-1",
      userId: "user-1",
      force: true,
      seed: true,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineVersionId: null,
        seedVersionId: "editor-version-1",
      }),
    );
  });

  test("starts over hand-written pages once the person confirms", async () => {
    const create = vi.fn(async () => ({
      outcome: "created" as const,
      job: queuedJob(),
    }));
    const service = new ProductionGenerationAdmissionService({
      source: {
        resolveTarget: vi.fn(async () => ({
          revision: "c".repeat(40),
          treeHash: "d".repeat(40),
        })),
      },
      baselines: {
        findCompatiblePublished: vi.fn(async () => null),
        handWrittenVersion: vi.fn(async () => "editor-version-1"),
      },
      jobs: { create },
      instructions: instructionsUnchanged(),
      executionConfig,
    });

    await service.admit({
      projectId: "project-1",
      userId: "user-1",
      force: true,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ baselineVersionId: null, seedVersionId: null }),
    );
  });
});

function queuedJob(): GenerationJobDto {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: "project-1",
    status: "queued",
    docsVersionId: null,
    errorMessage: null,
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
  };
}

function instructionsUnchanged() {
  return { changedSincePublished: vi.fn(async () => "unchanged" as const) };
}

async function noHandWrittenVersion(): Promise<string | null> {
  return null;
}
